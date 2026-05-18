import fs from "node:fs"

const packagePath = new URL("../package.json", import.meta.url)
const lockPath = new URL("../package-lock.json", import.meta.url)

const packageJson = readJson(packagePath)
const nextVersion = nextPatchVersion(packageJson.version)

packageJson.version = nextVersion
writeJson(packagePath, packageJson)

if (fs.existsSync(lockPath)) {
  const lockJson = readJson(lockPath)
  lockJson.version = nextVersion
  if (lockJson.packages?.[""]) {
    lockJson.packages[""].version = nextVersion
  }
  writeJson(lockPath, lockJson)
}

console.log(`userscript version bumped to ${nextVersion}`)

function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    throw new Error(`Expected package.json version like 0.1.0, got ${version}`)
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (patch >= 99999) {
    throw new Error(`Version ${version} is already at the 0.1.99999-style patch limit.`)
  }
  return `${major}.${minor}.${patch + 1}`
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"))
}

function writeJson(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
