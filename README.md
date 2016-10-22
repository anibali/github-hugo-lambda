# Github Hugo function for AWS Lambda

This is an AWS Lambda function for automatically building and deploying a static
Hugo website.

You must set up SNS, S3, and Lambda appropriately for this to be useful. See
the "Inspired by" section for help.

When GitHub triggers the function via SNS, this function:

1. Downloads the latest source code from GitHub
2. Generates the website from the source code with Hugo
3. Updates the S3 bucket with the new website


## Inspired by

* [How to host Hugo static website generator on AWS Lambda](http://bezdelev.com/post/hugo-aws-lambda-static-website/)
* [Dynamic GitHub Actions with AWS Lambda](https://aws.amazon.com/blogs/compute/dynamic-github-actions-with-aws-lambda/)
* [github-hugo-lambda](https://github.com/alex-glv/github-hugo-lambda)

## Prerequisites

* p7zip
* npm

## Install

1. Clone the repo
2. Edit sample config file and rename to config.json
3. `npm install`
4. `npm run package`
5. Upload `runhugo.zip` to AWS Lambda, using the Node 4.3.2 runtime

## Trying it locally

Requires [lambda-local](https://www.npmjs.com/package/lambda-local).

```sh
lambda-local -t 30 -l RunHugo.js -e /dev/null
```
