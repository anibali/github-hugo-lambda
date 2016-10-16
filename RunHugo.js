var async = require('async');
var util = require('util');
var child_process  = require('child_process');
var AWS = require('aws-sdk');
var config = require("./config.json");
var fs = require("fs");
var mime = require('mime');
var https = require('follow-redirects').https;
var AdmZip = require('adm-zip');

var pubDir = config.tmpDir + "/public";
var files;
function getFilesRecursive (folder) {
  var fileContents = fs.readdirSync(folder),
    fileTree = [],
    childTree = [],
    stats;

  fileContents.forEach(function (fileName) {
    stats = fs.lstatSync(folder + '/' + fileName);

    if (stats.isDirectory()) {
      folder = folder.replace(/\/$/, "");
      childTree = getFilesRecursive(folder + '/' + fileName).map(
      function(f) {
        var fWithPath = {name:  folder + '/' + fileName + f. name};
        fWithPath.name = fWithPath.name.replace(folder, "");
        return fWithPath;
      });
      fileTree = fileTree.concat(childTree);
    } else {
      fileTree.push({
          name: '/' + fileName
      });
    }
  });

  return fileTree;
};

function siteGenerate(srcDir, dstBucket, context) {
  async.waterfall([

  function runHugo(next) {
    console.log("Running hugo");
    var child = child_process.spawn("./hugo", ["-v", "--source=" + srcDir, "--destination=" + pubDir]);

    child.stdout.on('data', function (data) {
      console.log('hugo-stdout: ' + data);
    });
    child.stderr.on('data', function (data) {
      console.log('hugo-stderr: ' + data);
    });
    child.on('error', function(err) {
      console.log("hugo failed with error: " + err);
      context.done();
    });
    child.on('close', function(code) {
      console.log("hugo exited with code: " + code);
      next(null);
    });
  },
  function listContents(next) {
    var child = child_process.spawn("ls", ["-ltra", pubDir]);

    child.stdout.on('data', function (data) {
      console.log('ls-stdout: ' + data);
    });
    child.stderr.on('data', function (data) {
      console.log('ls-stderr: ' + data);
    });
    child.on('error', function(err) {
    console.log("error listing contents" + err);
        context.done();
    });
    child.on('close', function(code) {
    next(null);
    });
  },
  function syncRemoved(next) {
    files = getFilesRecursive(pubDir);
      var params = {
    Bucket: config.dstBucket
    };
    var s3 = new AWS.S3();
    s3.listObjects(params, function(err, data) {
      if (err) { console.log(err); context.done(); }
      // TODO: don't upload the file if it's of the same length

      data.Contents.forEach(function (data) {
        if (files
        .filter(function (e) { return e.name.substr(1) == data.Key; })
        .length == 0) {
        s3del = new AWS.S3();
        console.log("Removing key:" + data.Key);
        s3del.deleteObject({Bucket: config.dstBucket, Key: data.Key}, function (err, data) { if (err) { console.log(err);throw err;}});
        }
      });
    });
    next(null);
  },
  function upload(next) {
    var totalUploaded = 0;
    files.forEach(function (filename) {
      var fileStream = fs.createReadStream(pubDir + '/' + filename.name);
      fileStream.on('error', function (err) {
        if (err) { console.log(err);context.done();}
      });
      fileStream.on('open', function () {
        var s3 = new AWS.S3();
        console.log("Uploading: " + filename.name.substr(1));
        s3.putObject({
        Bucket: config.dstBucket,
        Key: filename.name.substr(1),
        ContentType: mime.lookup(filename.name),
        Body: fileStream
        }, function (err) {
        if (err) { console.log(err);context.done();}
        });
      });
    });
    next(null);
  },

  ], function(err) {
    if (err) console.error("Failure because of: " + err);
    else console.log("All methods in waterfall succeeded.");
    context.done();
  });
}

exports.handler = function(event, context) {
  var tmpFilePath = "/tmp/master" + Math.round(Math.random () * 100) + ".zip";
  var dlUrl = "https://github.com/" + config.owner + "/" + config.repo + "/archive/master.zip";
  var srcDir = config.tmpDir + "/" + config.repo + "-";
  if (event.Records != null && event.Records[0]) {
    console.log(event.Records[0]);
    var snsEventJson = JSON.parse(event.Records[0].Sns.Message);
    if (snsEventJson.ref != "refs/heads/master") {
      console.log("Not master ref, but " + snsEventJson.ref);
      context.done();
    } else {
      dlUrl = "https://github.com/" + config.owner + "/" + config.repo + "/archive/" + snsEventJson.after + ".zip";
      srcDir = srcDir + snsEventJson.after;
    }
  } else {
    srcDir = srcDir + "master";
  }
  console.log("archive url: " + dlUrl);
  https.get(dlUrl, function(response) {
    response.on('data', function (data) {
      fs.appendFileSync(tmpFilePath, data);
    });
    response.on('end', function() {
      console.log("Zip: " + tmpFilePath);
      var zip = new AdmZip(tmpFilePath);
      zip.extractAllTo(config.tmpDir);
      siteGenerate(srcDir, config.dstBucket, context);
    });
  });
};
