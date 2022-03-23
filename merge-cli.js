#!/usr/bin/env node

const { merge } = require('./merge-lib')
const { Command } = require('commander')

const program = new Command()
const { version: pkgVersion } = require('./package.json')
program.version(pkgVersion)

program
  .option('-m, --move', 'move files instead of making copies; remove directories except target')
  .option('-s, --silent', 'No console output unless error')
  // TODO MAYBE? option for verbose/progress output
  .action(function() {
    const opts = {}
    if (program.move) {
      opts.move = true
    }
    merge(program.args, opts)
    .then(() => {
      if (!program.silent)
        console.log("Success.")
    })
    .catch(err => {
      console.error("Failure:", err.message)
      if (!err.code && !program.silent)
        console.log('\n' + program.helpInformation())
      process.exitCode = 1
    })
  })

program.parse()
