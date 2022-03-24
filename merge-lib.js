const Emitter = require('events')
const path = require('path')
const util = require('util')
const promisify = util.promisify || require('./simple-promisify')

const fs = require('graceful-fs')
const mkdirp = require('mkdirp')
const ndt = require('npm-package-dl-tracker')
const ndtCreateAsync = promisify(ndt.create)
const reconstructMap = require('npm-package-dl-tracker/reconstruct-map')
const rimrafAsync = promisify(require('rimraf'))

const ft = require('./file-tools')

const MAPFILENAME = 'dltracker.json'
const RE_HEX40 = /^[a-f0-9]{40}$/ // git commit hash pattern
const DEBUG = true

const log = DEBUG ? {
  error: function(func, msg) { console.error("ERR! %s: %s", func, msg) },
  info: function(func, msg) { console.log("INFO %s: %s", func, msg) }
} : {
  error: function() {},
  info: function() {}
}

const emitter = new Emitter()

/*
* MV semantics will be an option; CP semantics will be the default
* The last arg will be taken to be the destination
* If the destination directory does not exist, it must be at least the 3rd arg
* Provided that the last arg is at least the 3rd, it will be created if it doesn't exist
*/

function merge(args, cfg) {
  const arg1ErrorMsg = "First argument must be an array of paths"
  let err
  if (args === undefined || args === null)
    err = new SyntaxError(arg1ErrorMsg)
  else if (typeof args != 'object' || !(args instanceof Array))
    err = new TypeError(arg1ErrorMsg)
  else if (args.length < 2)
    err = new SyntaxError("At least two paths are required")
  else {
    const dirsSoFar = new Set()
    for (let i = 0; i < args.length; ++i) {
      const elType = typeof args[i]
      if (elType != 'string') {
        err = new TypeError(`Path arguments must be strings; ${elType} found`)
        break
      }
      // There are multiple ways to represent a path;
      // to catch a duplicate, we must always resolve:
      const item = path.resolve(args[i])
      if (dirsSoFar.has(item)) {
        err = new SyntaxError(`Duplicate path in arguments: ${args[i]}`)
        break
      }
      dirsSoFar.add(item)
    }
  }
  cfg = cfg || {}
  if (!err) {
    if (typeof cfg != 'object')
      err = new TypeError("Config argument must be an object")
    else if (Object.getPrototypeOf(cfg) != Object.getPrototypeOf({}))
      err = new TypeError("Config argument must be a plain object")
    // Currently the only supported option is 'move'
    else if ('move' in cfg) {
      const optType = typeof cfg.move
      if (optType != 'boolean')
        err = new TypeError(`boolean required for 'move' option; ${optType} found`)
    }
  }
  if (err) return Promise.reject(err)

  const srcCount = args.length - 1
  return initialize(args).then(tracker => {
    function nextDirXfer(i) {
      // Until we find out we need to resolve something else...
      if (i >= srcCount) return null
      return transferAll(args[i], tracker, cfg)
      .then(() => nextDirXfer(i + 1))
    }
    return nextDirXfer(0).then(() => {
      emitter.emit('msg', 'info',
        `Writing tracker data at ${tracker.path} ...`
      )
      return promisify(tracker.serialize)()
    })
  })
  .then(() => {
    if (!cfg.move) return null

    function nextDirDel(i) {
      if (i >= srcCount) return null
      emitter.emit('msg', 'info', `Removing directory ${args[i]} ...`)
      return rimrafAsync(args[i]).then(() => nextDirDel(i+1))
    }
    return nextDirDel(0)
  })
}

// initialize() is *not* going to be exposed in the 'library' API, because the
// purpose of the module is to merge tracker directories, *not* give access to
// the inner workings. Therefore, there will be no errors thrown here for bad
// arguments, because they will already have been vetted by the caller.
// Called by merge
function initialize(args) {
  let i = 0

  function processNextArg() {
    const arg = args[i]
    return validateDir(arg)
    .then(tracker => {
      return ++i < args.length ? processNextArg() : Promise.resolve(tracker)
    })
    .catch(err => {
      // It's OK for the last of at least 3 directories to not exist yet,
      // so only send back an error if it's not that specific situation
      let result
      if (!(i == args.length - 1 && args.length > 2 && err.code == 'ENOENT'))
        result = Promise.reject(err)
      else result = Promise.resolve(null)
      return result
    })
  }

  return processNextArg()
  .then(lastTracker => {
    if (lastTracker) return Promise.resolve(lastTracker)
    // else the last directory doesn't exist yet.
    const lastDir = args[args.length - 1]
    emitter.emit('msg', 'warn', `Need to create path: ${lastDir}`)
    return new Promise((resolve, reject) => {
      mkdirp(lastDir, function(err) {
        if (err) return reject(err)
        ndt.create(lastDir, function(err, tracker) {
          err ? reject(err) : resolve(tracker)
        })
      })
    })
  })
}

/*
I've decided not to make an issue over an empty directory. Although it's surely
abuse of this module to pass one (when not the last of at least 3 directories),
it's more work than it's worth to stop the user from doing it.
*/
// Called by initialize() for each command line argument
function validateDir(dirPath) {
  return ndtCreateAsync(dirPath)
  .then(tracker => {
    return new Promise((resolve, reject) => {
      fs.access(path.join(dirPath, MAPFILENAME), function(err) {
        // There's no point in running an audit if the tracker was not loaded
        // from a map file.
        // err will be ENOENT. A more serious error would have been identified
        // by ndt.create().
        if (err) {
          emitter.emit('msg', 'warn', `No ${MAPFILENAME} found at ${dirPath}`)
          return resolve(tracker)
        }

        emitter.emit('msg', 'info', `Running audit on tracker for ${dirPath} ...`)
        tracker.audit((err, data) => {
          if (err) return reject(err)
          if (data.length) {
            err = new Error(
              `Problems in dltracker directory '${dirPath}'.`
              + '\nRun dltracker-doctor on it before trying to use it.'
            )
            err.code = 'ENEEDSDOCTOR'
            return reject(err)
          }
          resolve(tracker)
        })
      })
    })
  })
}

// Called by merge
function transferAll(dir, tracker, cfg) {
  const trackerAddAsync = promisify(tracker.add)
  const xferFunc = cfg.move ? ft.mv : ft.copyFile
  const xferWord = cfg.move ? 'Moving' : 'Copying'
  return mergedDataCollection(dir, tracker).then(list => {
    function nextCoreRecord(i) {
      if (i >= list.length) return Promise.resolve(null)
      const data = list[i]
      if (data.type == 'tag') return nextTagRecord(i)

      const srcPath = path.join(dir, data.filename)
      emitter.emit('msg', 'info', `${xferWord} ${data.filename} from ${dir} to ${tracker.path}`)
      return xferFunc(srcPath, tracker.path)
      .catch(err => {
        if (err.code != 'EEXIST') throw err
        emitter.emit('msg', 'warn', `${data.filename} already exists at ${tracker.path}`)
      })
      .then(() => trackerAddAsync(data.type, data))
      .then(() => nextCoreRecord(i+1))
    }
    function nextTagRecord(i) {
      if (i >= list.length) return Promise.resolve(null)
      const data = list[i]
      if (data.type != 'tag') return nextCoreRecord(i)

      // We know that we can do the following because we added all the semver
      // records before we got here, and that the JSON source file is valid.
      data.filename = tracker.getData('semver', data.name, data.version).filename
      return trackerAddAsync('tag', data)
      .then(() => nextTagRecord(i+1))
    }

    return nextCoreRecord(0)
  })
}

// Called by transferAll
function mergedDataCollection(dir, tracker) {
  return getTrackerMap(dir).then(map => {
    const results = []

    let pkgs = map.semver || {}
    for (let name in pkgs) {
      const versions = pkgs[name]
      for (let ver in versions) {
        const data = versions[ver]
        Object.assign(data, { type: 'semver', name: name, version: ver })
        results.push(mergedData(data, tracker)) // May throw
      }
    }

    pkgs = map.tag || {}
    for (let name in pkgs) {
      const tags = pkgs[name]
      for (let tag in tags) {
        if (tracker.contains('tag', name, tag)) continue;
        const data = tags[tag] // contains the version reference
        Object.assign(data, { type: 'tag', name: name, spec: tag })
        // A tag record only references a semver record; no extra data,
        // so there's nothing to merge.
        results.push(data)
      }
    }

    pkgs = map.git || {}
    for (let repo in pkgs) {
      const refs = pkgs[repo]
      for (let ref in refs) {
        // git refs that are not commit hashes will be handled automatically
        // by tracker.add, as long as there is a git commit record with a 'refs'
        // array that includes the git ref
        if (!RE_HEX40.test(ref)) continue

        const data = refs[ref]
        Object.assign(data, { type: 'git', repo: repo, commit: ref })
        results.push(mergedData(data, tracker)) // May throw
      }
    }

    pkgs = map.url || {}
    for (let spec in pkgs) {
      const data = pkgs[spec]
      Object.assign(data, { type: 'url', spec: spec })
      results.push(mergedData(data, tracker)) // May throw
    }

    return results
  })
}

// Given directory has already been verified existing and accessible.
// Still unknown (outside of the dltracker instance used to verify) is
// whether the directory has a dltracker.json file.
// If it does, then parse it; otherwise, reconstruct the data from the
// directory contents.
// Called by mergedDataCollection.
function getTrackerMap(dir) {
  return new Promise((resolve, reject) => {
    fs.readFile(path.join(dir, MAPFILENAME), 'utf8', (err, txt) => {
      if (err) {
        if (err.code == 'ENOENT') {
          emitter.emit('msg', 'warn', `Need to reconstruct map of packages at ${dir}`)
          return reconstructMap(dir, function(err, mapData) {
            if (err) return reject(err)
            resolve(mapData)
          })
        }
        return reject(err)
      }
      // Strip BOM, if any
      if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1)
      let mapData
      try { mapData = JSON.parse(txt) }
      catch (err) { return reject(err) }
      resolve(mapData)
    })
  })
}

// Called by mergedDataCollection.
function mergedData(srcData, tracker) {
  let name, spec
  switch (srcData.type) {
    case 'semver':
      name = srcData.name
      spec = srcData.version
      break
    case 'git':
      name = srcData.repo
      spec = srcData.commit
      break
    case 'url':
      spec = srcData.spec 
      break
  }
  const destData = tracker.getData(srcData.type, name, spec)
  if (!destData) return srcData
  for (let prop in srcData) {
    if (!(prop in destData)) destData[prop] = srcData[prop]
    else if (destData[prop] != srcData[prop]) {
      const err = new Error('merge data conflict');
      if (name) err.pkgName = name
      Object.assign(err, {
        pkgSpec: spec,
        property: prop,
        source: srcData[prop],
        target: destData[prop]
      })
      throw err
    }
  }
  return destData
}

module.exports = {
/*
  validate: validateDir,
  initialize: initialize,
  getTrackerMap: getTrackerMap,
  mergedData: mergedData,
  mergedDataCollection: mergedDataCollection,
*/
  emitter: emitter,
  merge: merge
}
