const child_process  = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const request = require('request');
const AWS = require('aws-sdk');
const mime = require('mime');
const AdmZip = require('adm-zip');

const config = require('./config.json');

function getFilesRecursive(folder) {
  var fileContents = fs.readdirSync(folder),
    fileTree = [],
    childTree = [],
    stats;

  fileContents.forEach(function (fileName) {
    stats = fs.lstatSync(folder + '/' + fileName);

    if (stats.isDirectory()) {
      folder = folder.replace(/\/$/, '');
      childTree = getFilesRecursive(path.join(folder, fileName))
        .map(f => path.join(fileName, f));
      fileTree = fileTree.concat(childTree);
    } else {
      fileTree.push(fileName);
    }
  });

  return fileTree;
};

// Runs Hugo to generate the static website from input files.
const runHugo = (srcDir, dstDir) => {
  console.log('\n[3] Run Hugo');

  return new Promise((resolve, reject) => {
    console.log('Running Hugo...');
    const child = child_process.spawn('./hugo', ['-v', '--source=' + srcDir, '--destination=' + dstDir]);

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    child.on('error', function(err) {
      console.log('Hugo failed with error: ' + err);
      reject(err);
    });
    child.on('close', function(code) {
      console.log('Hugo exited with code: ' + code);
      resolve();
    });
  });
};

// Generates three lists of keys which represent the changes which should be
// made to S3 to bring it up to date with local files:
// keysToAdd, keysToUpdate, keysToRemove.
const diffLocalFilesWithS3 = (dstBucket, pubDir) => {
  console.log('\n[4] Diff local files with S3');

  return new Promise((resolve, reject) => {
    const keys = getFilesRecursive(pubDir);

    const params = {
      Bucket: dstBucket
    };
    const s3 = new AWS.S3();
    s3.listObjectsV2(params, function(err, data) {
      const keysToAdd = keys.filter(key => !data.Contents.find(s3Obj => s3Obj.Key === key));

      const keysToUpdate = [];
      const keysToRemove = [];

      const promises = [];

      data.Contents.forEach(s3Obj => {
        if(keys.filter(key => key === s3Obj.Key).length === 0) {
          keysToRemove.push(s3Obj.Key);
        } else {
          const filePath = path.join(pubDir, s3Obj.Key);
          const fileStream = fs.createReadStream(filePath);
          const hash = crypto.createHash('md5').setEncoding('hex');

          promises.push(new Promise((resolve, reject) => {
            fileStream.on('error', reject);
            fileStream.on('open', () => {
              fileStream.pipe(hash).on('finish', () => {
                if(hash.read() !== JSON.parse(s3Obj.ETag)) {
                  keysToUpdate.push(s3Obj.Key);
                }
                resolve();
              });
            });
          }));
        }
      });

      Promise.all(promises)
        .then(() => {
          console.log(util.format('%d files to add', keysToAdd.length));
          console.log(util.format('%d files to update', keysToUpdate.length));
          console.log(util.format('%d files to remove', keysToRemove.length));

          resolve({ keysToAdd, keysToUpdate, keysToRemove });
        })
        .catch(reject);
    });
  })
}

const removeFromS3 = (dstBucket, keysToRemove) => {
  console.log('\n[5] Remove old keys from S3');

  if(keysToRemove.length == 0) {
    console.log('Nothing to remove from S3.');
    return null;
  }

  const s3 = new AWS.S3();

  const promises = keysToRemove.map(key => new Promise((resolve, reject) => {
    console.log('- ' + key);
    s3.deleteObject({
      Bucket: dstBucket,
      Key: key
    }, err => {
      if(err) {
        reject(err);
      } else {
        resolve();
      }
    });
  }));

  return Promise.all(promises);
};

const uploadToS3 = (dstBucket, keysToUpload, pubDir) => {
  console.log('\n[6] Upload new and updated files to S3');

  if(keysToUpload.length == 0) {
    console.log('Nothing to upload to S3.');
    return null;
  }

  const s3 = new AWS.S3();

  const promises = keysToUpload.map(key => new Promise((resolve, reject) => {
    const filePath = path.join(pubDir, key);
    const fileStream = fs.createReadStream(filePath);

    fileStream.on('error', reject);
    fileStream.on('open', () => {
      console.log('+ ' + key);
      s3.putObject({
        Bucket: dstBucket,
        Key: key,
        ContentType: mime.lookup(key),
        Body: fileStream
      }, err => {
        if(err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }));

  return Promise.all(promises);
};

exports.handler = function(event, context, callback) {
  const tmpDir = '/tmp/hugo-' + crypto.randomBytes(4).readUInt32LE(0);
  fs.mkdir(tmpDir, (err) => {
    if(err) {
      callback(err);
    } else {
      var codeZipPath = path.join(tmpDir, 'master.zip');
      var dlUrl = 'https://github.com/' + config.owner + '/' + config.repo + '/archive/master.zip';
      var srcDir = tmpDir + '/' + config.repo + '-';
      if (event.Records != null && event.Records[0]) {
        console.log(event.Records[0]);
        var snsEventJson = JSON.parse(event.Records[0].Sns.Message);
        if (snsEventJson.ref != 'refs/heads/master') {
          console.log('Not master ref, but ' + snsEventJson.ref);
          callback(null, 'No change, GitHub hook not for master branch');
        } else {
          dlUrl = 'https://github.com/' + config.owner + '/' + config.repo + '/archive/' + snsEventJson.after + '.zip';
          srcDir = srcDir + snsEventJson.after;
        }
      } else {
        srcDir = srcDir + 'master';
      }

      console.log('\n[1] Download code archive');
      console.log('Downloading code archive from: ' + dlUrl);

      request.get(dlUrl).pipe(fs.createWriteStream(codeZipPath)).on('finish', () => {
        console.log('Download complete');

        console.log('\n[2] Extract code archive');

        var zip = new AdmZip(codeZipPath);
        zip.extractAllTo(tmpDir);
        console.log('Code extracted to: ' + tmpDir);

        const pubDir = tmpDir + '/public';

        runHugo(srcDir, pubDir)
          .then(() => diffLocalFilesWithS3(config.dstBucket, pubDir))
          .then(diff => Promise.all([
            removeFromS3(config.dstBucket, diff.keysToRemove),
            uploadToS3(config.dstBucket, diff.keysToAdd.concat(diff.keysToUpdate), pubDir)
          ]))
          .catch((err) => {
            console.error(err);
            callback(err)
          })
          .then(() => {
            callback(null, 'Successfully built and uploaded');
          });
      });
    }
  });
};
