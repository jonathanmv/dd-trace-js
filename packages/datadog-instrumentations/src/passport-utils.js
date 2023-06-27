'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')
const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (username, password, verified, strategy) {
  if (passportVerifyChannel.hasSubscribers) {
    return shimmer.wrap(verified, function (err, user, info) {
      const credentials = { type: strategy, username }
      passportVerifyChannel.publish({ credentials, user })
      return verified.apply(this, arguments)
    })
  } else {
    return verified
  }
}

function wrapVerify (verify, passReq, type) {
  if (passReq) {
    return function (req, username, password, verified) {
      arguments[3] = wrapVerifiedAndPublish(username, password, verified, type)
      return verify.apply(this, arguments)
    }
  } else {
    return function (username, password, verified) {
      arguments[2] = wrapVerifiedAndPublish(username, password, verified, type)
      return verify.apply(this, arguments)
    }
  }
}

module.exports = {
  wrapVerify
}
