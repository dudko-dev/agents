// Which packages have a version that is not on npm yet. Prints GitHub Actions outputs:
//   matrix=[{dir,name,version,tag}]  any=true|false  agent=true|false
// Run with --human for a readable list. The order is the publish order: the browser core before
// the React bindings that peer on it.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const DIRS = ['agent', 'agent-web', 'agent-web-react']

const isPublished = (name, version) => {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() === version
  } catch (err) {
    // E404 = this version (or the package) is not on npm. Anything else - the registry is down,
    // the network failed - must NOT be read as "not published": stop instead of guessing.
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`
    if (/E404|404 Not Found|is not in this registry/.test(text)) return false
    throw new Error(`npm view ${name}@${version} failed: ${text.trim() || err.message}`)
  }
}

const packages = DIRS.map((dir) => {
  const pkg = JSON.parse(readFileSync(new URL(`../../packages/${dir}/package.json`, import.meta.url)))
  if (pkg.private) throw new Error(`packages/${dir} is private`)
  return { dir, name: pkg.name, version: pkg.version, tag: `${dir}-v${pkg.version}` }
})
const todo = packages.filter((p) => !isPublished(p.name, p.version))

if (process.argv.includes('--human')) {
  for (const p of packages) {
    console.log(`${todo.includes(p) ? 'PUBLISH' : 'on npm '}  ${p.name}@${p.version}  (${p.tag})`)
  }
} else {
  console.log(`matrix=${JSON.stringify(todo)}`)
  console.log(`any=${todo.length > 0}`)
  console.log(`agent=${todo.some((p) => p.dir === 'agent')}`)
}
