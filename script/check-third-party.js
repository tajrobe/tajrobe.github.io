/*
 * Fails the build if the site would ship third-party code that nobody approved.
 *
 * Written after a base64-obfuscated popunder loader (cdn4ads.com, plus three
 * fallback domains) lived in _layouts/default.html for months and survived two
 * redesigns. It was invisible in review because the domains were base64 and the
 * payload was one minified line at the bottom of a layout.
 *
 * On a site whose entire promise is that reviews are anonymous, any third-party
 * script can read a review while the user is typing it. So this is not a lint
 * rule, it is the thing that keeps the promise. It checks four properties:
 *
 *   1. every subresource in the markup comes from an approved host
 *   2. no file carries the fingerprints of an obfuscated script loader
 *   3. vendored libraries still hash to what they hashed to when we vetted them
 *   4. the CSP in the layout still matches the allowlist below
 *
 * Run: npm run check
 */

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

// Hosts allowed to serve code, styles, fonts, images, or receive form posts.
// Adding one is a deliberate, reviewed decision. Keep it in step with the
// Content-Security-Policy in _layouts/default.html; check 4 enforces that.
const ALLOWED_HOSTS = [
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'js.hcaptcha.com',
  'placehold.co',
  'api.github.com',
  'get-review-form.tajrobe98.workers.dev'
]

// Third-party libraries committed into the repo. We do not read minified code
// on every PR, so we pin it: if the bytes change, CI stops and a human looks.
const VENDORED = [
  'assets/jalali-moment.browser-v3.3.11.js',
  'assets/slimselect.min.js',
  'assets/slimselect.min.css'
]

const HTML_DIRS = ['.', '_layouts', '_includes']
const FIRST_PARTY_JS = ['assets/fetch.js', 'extension-data-generator.js']

// Tags that pull in a resource. An <a href> is navigation, not code, so links
// to twitter or jobinja are none of our business here.
const SUBRESOURCE = /<(script|link|iframe|img|form)\b[^>]*?\b(?:src|href|action)\s*=\s*["']([^"']+)["']/gi

// Fingerprints of the ad-loader family. These strings have no honest reason to
// appear in this repo.
const SIGNATURES = [
  { pattern: /popundersPerIP|topmostLayer|defaultPerDay|\bminBid\b/i, why: 'popunder ad-network config key' },
  { pattern: /data-cfasync/i, why: 'attribute used to hide a script from Cloudflare rewriting' },
  { pattern: /\/\*<!\[CDATA\[\/\*/, why: 'CDATA wrapper used to smuggle minified payloads' }
]

const BASE64_LITERAL = /["']([A-Za-z0-9+/]{24,}={0,2})["']/g

const findings = []

function report (file, message) {
  findings.push({ file, message })
}

// The site's own origin, written out in full in canonical links and redirects.
// That is 'self', not a third party. Read it from _config.yml so this keeps
// working if the site ever moves to another domain.
async function readSelfHost () {
  const config = await fs.readFile('_config.yml', 'utf-8')
  const url = config.match(/^url:\s*(\S+)/m)
  return url ? url[1].replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null
}

async function listFiles (dir, extension) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(extension))
    .map(entry => path.posix.join(dir, entry.name))
}

// 1. Every subresource must come from an approved host.
function checkSubresourceHosts (file, source, selfHost) {
  for (const [, tag, url] of source.matchAll(SUBRESOURCE)) {
    // Relative paths and Liquid-templated URLs stay on our own origin.
    if (!/^(https?:)?\/\//.test(url)) continue

    const host = url.replace(/^(https?:)?\/\//, '').split(/[/?#]/)[0]
    if (host === selfHost) continue
    if (!ALLOWED_HOSTS.includes(host)) {
      report(file, `<${tag}> loads from unapproved host "${host}".\n` +
        `    If this is intentional, add it to ALLOWED_HOSTS and to the CSP in _layouts/default.html.`)
    }
  }
}

// 2. No obfuscated loader fingerprints.
function checkSignatures (file, source) {
  for (const { pattern, why } of SIGNATURES) {
    const match = source.match(pattern)
    if (match) report(file, `contains "${match[0]}" — ${why}.`)
  }
}

// A loader hides its domains as base64 so that grepping for the domain finds
// nothing. So decode the base64 and look at what comes out.
function checkEncodedUrls (file, source) {
  for (const [, literal] of source.matchAll(BASE64_LITERAL)) {
    let decoded
    try {
      decoded = Buffer.from(literal, 'base64').toString('utf8')
    } catch {
      continue
    }
    if (!/^[\x20-\x7e]+$/.test(decoded)) continue // not text, not a URL

    if (/:\/\//.test(decoded) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(decoded)) {
      report(file, `has a base64 string that decodes to a URL: "${decoded}".\n` +
        `    Encoding a URL is how the 2025 ad injection stayed hidden. Write URLs in plain text.`)
    }
  }
}

// 3. Vendored libraries must still be the bytes we vetted.
async function checkVendorIntegrity () {
  const pinPath = 'script/vendor-integrity.json'
  const pins = JSON.parse(await fs.readFile(pinPath, 'utf-8'))

  for (const file of VENDORED) {
    const bytes = await fs.readFile(file)
    const actual = crypto.createHash('sha256').update(bytes).digest('hex')

    if (!pins[file]) {
      report(pinPath, `no pinned hash for vendored file "${file}".`)
    } else if (pins[file] !== actual) {
      report(file, `vendored file changed but its pinned hash did not.\n` +
        `    expected ${pins[file]}\n` +
        `    actual   ${actual}\n` +
        `    Read the diff. If the change is legitimate, update ${pinPath}.`)
    }
  }
}

// 4. The CSP and this allowlist must not drift apart.
async function checkCsp () {
  const file = '_layouts/default.html'
  const layout = await fs.readFile(file, 'utf-8')
  const csp = layout.match(/http-equiv="Content-Security-Policy"[^>]*?content="([^"]+)"/is)

  if (!csp) {
    report(file, 'the Content-Security-Policy meta tag is gone. It is the only thing stopping an injected script from loading remote code; restore it.')
    return
  }

  const policy = csp[1]
  for (const host of ALLOWED_HOSTS) {
    // The worker URL is templated into the CSP via Liquid, so it is never literal.
    if (host.endsWith('.workers.dev')) continue
    if (!policy.includes(host)) {
      report(file, `"${host}" is in ALLOWED_HOSTS but missing from the CSP, so the browser will block it.`)
    }
  }
  for (const directive of ["object-src 'none'", "base-uri 'self'", "default-src 'self'"]) {
    if (!policy.includes(directive)) report(file, `CSP is missing "${directive}".`)
  }
}

async function main () {
  const selfHost = await readSelfHost()
  const htmlFiles = (await Promise.all(HTML_DIRS.map(dir => listFiles(dir, '.html')))).flat()

  for (const file of htmlFiles) {
    const source = await fs.readFile(file, 'utf-8')
    checkSubresourceHosts(file, source, selfHost)
    checkSignatures(file, source)
    checkEncodedUrls(file, source)
  }

  // Vendored code is pinned by hash instead of scanned: minified libraries are
  // full of strings that trip the heuristics above.
  for (const file of FIRST_PARTY_JS) {
    const source = await fs.readFile(file, 'utf-8')
    checkSignatures(file, source)
    checkEncodedUrls(file, source)
  }

  await checkVendorIntegrity()
  await checkCsp()

  if (findings.length === 0) {
    console.log(`OK — ${htmlFiles.length + FIRST_PARTY_JS.length} files scanned, ${VENDORED.length} vendored files verified, no unapproved third-party code.`)
    return
  }

  console.error(`\nThird-party code check failed with ${findings.length} problem(s):\n`)
  for (const { file, message } of findings) {
    console.error(`  ${file}: ${message}\n`)
  }
  console.error('This check exists because an ad loader once shipped to users unnoticed.')
  console.error('Do not silence it without understanding what it caught.\n')
  process.exitCode = 1
}

main()
