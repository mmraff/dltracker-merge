# dltracker-merge
Combine directories of packages obtained by the `npm download` command

## Overview
*The `npm download` command is only available when an installation of `npm` has been overlaid with [npm-two-stage](https://github.com/mmraff/npm-two-stage#readme).
The official `npm` interface **does not** have a `download` command at this time.*

In short, `npm download` fetches named packages, and all the packages of their dependency trees, as a means of collecting all that is needed for offline installation on another system.
In the process, it creates a simple database of metadata for those packages, and stores it in a file named `dltracker.json`.
(See the [README for npm-download-tracker](https://github.com/mmraff/npm-download-tracker#readme), a.k.a. the npm package `npm-package-dl-tracker`).

If one has used this command several times, retaining the results but not always reusing the same target directory, it may result in many duplicate copies of packages distributed across multiple directories.

Manually moving files from one directory to another does not solve the problem, but renders the moved packages unusable, because it does not honor the records of the package metadata stored in the corresponding JSON files.

This module provides a command to reduce package redundancy without losing anything, by merging directories of packages and the JSON files that govern them.

**Warning:** merging download directories can lead to a directory of thousands of packages, which can result in degraded installation performance. Whether by merging or by downloading, collecting multiple thousands of packages in one directory is discouraged. Moderation is encouraged.

## To Install

Typical CLI use is from a global installation:
```
$ npm install -g dltracker-merge
```
But local installation is valid, and possibly useful for the library module:
```
$ npm install --save dltracker-merge
```

## CLI Usage
Enter the `dltmerge` command with the paths of two or more `npm download` directories.
```
$ dltmerge PATH_1 PATH_2 [... PATH_n]
```
* The last named directory will be the destination of the merger.
* Directories can be empty.
* The last of at least 3 paths can be non-existent, in which case it is created by dltmerge.

By default, dltmerge copies files. An option is provided to move files instead:
```
$ dltmerge --move PATH_1 PATH_2 [... PATH_n]
```
With this option, the source directories (all but the last of the given paths) are removed upon completion.

`dltmerge` produces minimal console output, but an option is provided to omit all but error output:
```
$ dltmerge --silent PATH_1 PATH_2 [... PATH_n]
```

Show version and exit:
```
$ dltmerge --version
```

## Library Module API
**merge-lib.js** exposes only a function and a message emitter.

```js
const mergeLib = require('dltracker-merge/merge-lib')

mergeLib.emitter.on('msg', (level, message) => {
  // Maybe test level, then do something with message...
})

const directories = ['path1', 'path2', 'path/to/destination'];
mergeLib.merge(directories)
.then(() => {
  const sources = directories.slice(0, -1)
  const dest = directories.slice(-1)
  console.log(`Successfully merged contents of ${sources.join(', ')} into ${dest}`)
})
```
### `mergeLib.emitter` {events.EventEmitter}
A single event `'msg'` is implemented. The handler is passed two arguments:
* `level` {string} One of `'info'`|`'warn'`
* `message` {string} A report of the current point in the program activity

### `mergeLib.merge(directories[, options])` &rarr; `Promise<empty>`
* `directories` {Array&lt;string&gt;} Paths to two or more directories. The bulleted statements in CLI Usage above apply the same here.
* `options` {object} *Optional* A hash of option settings. Currently supported properties:
  - `move` {boolean} Move rather than copy files. Default `false`.

------

**License: MIT**
