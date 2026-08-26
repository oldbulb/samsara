import { describe, expect, it } from 'vitest'
import { REFRESHED_EVENT, bootstrapScript, navOf, recipesCss, shell, tokensCss } from '../src/theme.ts'

describe('tokensCss', () => {
  const css = tokensCss()

  it('declares the light palette on body and the dark one under body[data-ds-dark-theme]', () => {
    expect(css).toMatch(/^body \{/)
    expect(css).toContain('body[data-ds-dark-theme] {')
    const [light, dark] = css.split('body[data-ds-dark-theme] {')
    expect(light).toContain('--dsw-alias-bg-base: #fff;')
    expect(light).toContain('--dsw-alias-state-business-primary: rgb(65,118,230);')
    expect(light).toContain('--dsw-alias-label-primary: rgb(15,17,21);')
    expect(dark).toContain('--dsw-alias-bg-base: rgb(21,21,23);')
    expect(dark).toContain('--dsw-alias-state-business-primary: rgb(103,158,254);')
    expect(dark).toContain('--dsw-alias-label-primary: rgb(249,250,251);')
    expect(css).not.toContain(':root')
    expect(css).not.toContain('prefers-color-scheme')
  })

  it('redefines every dark token from the light block', () => {
    const [light, dark] = css.split('body[data-ds-dark-theme] {')
    const names = (s: string) => new Set([...s.matchAll(/(--dsw-alias-[\w-]+|--dsw-specific-[\w-]+):/g)].map((m) => m[1]))
    for (const name of names(dark!)) expect(names(light!)).toContain(name)
  })

  it('carries the font stacks with no bare monospace tail', () => {
    expect(css).toContain("--dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI'")
    expect(css).toMatch(/--ds-font-family-code: 'SF Mono'.*'Microsoft YaHei';/)
    expect(css).not.toMatch(/,\s*monospace/)
  })
})

describe('recipesCss', () => {
  const css = recipesCss()

  it('has the card, table, badge tones, pill, stat block, code and focus ring recipes', () => {
    expect(css).toContain('.card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;')
    expect(css).toContain('th { height: 30px;')
    expect(css).toContain('.tbl { overflow-x: auto;')
    for (const tone of ['ok', 'warn', 'danger', 'neutral']) expect(css).toContain(`.badge.${tone} {`)
    expect(css).toContain('.badge.shadow { box-shadow: var(--dsw-shadow-lv1); }')
    expect(css).toContain('.pill { display: inline-flex; align-items: center; height: 24px;')
    expect(css).toContain('.stat { display: grid; grid-template-columns: fit-content(180px) minmax(0, 1fr); column-gap: 12px;')
    expect(css).toContain('.code { background: var(--dsw-alias-markdown-code-block); border-radius: 12px;')
    expect(css).toContain(':focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }')
  })

  it('keeps the house sizes: 12px tables, 14px prose, weight 500 for emphasis', () => {
    expect(css).toContain('body { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: 14px/22px var(--dsw-font-family);')
    expect(css).toContain('table { border-spacing: 0; width: 100%; font-size: 12px;')
    expect(css).not.toMatch(/font-weight: [67]00/)
  })
})

describe('shell', () => {
  const html = shell({ title: 'over<view>', nav: navOf('/samsara', 'home'), base: '/samsara', body: '<section><h2>Body</h2></section>', refreshMs: 1000 })

  it('is one self-contained document with the bootstrap right after <body>', () => {
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/)
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain('<title>over&lt;view&gt; · samsara</title>')
    expect(html).toContain(`<body>\n${bootstrapScript()}`)
    expect(html).toContain("document.body.toggleAttribute('data-ds-dark-theme',d)")
    expect(html).not.toMatch(/<link\s/i)
    expect(html).not.toMatch(/<script\s+src=/i)
    expect(html).not.toMatch(/https?:\/\//)
    expect((html.match(/<style>/g) ?? []).length).toBe(1)
    expect(html).toContain(tokensCss())
    expect(html).toContain(recipesCss())
  })

  it('shows the text wordmark and the five nav entries with the active one marked', () => {
    expect(html).toContain('<a class="wordmark" href="/samsara">samsara</a>')
    expect(html).not.toMatch(/whale|<svg/i)
    expect(html).toContain('<a class="pill active" href="/samsara/" aria-current="page">Home</a>')
    for (const [label, href] of [['Experiments', '/samsara/experiments'], ['Rounds', '/samsara/#rounds'], ['Servings', '/samsara/servings'], ['Bench', '/samsara/bench']]) {
      expect(html).toContain(`<a class="pill" href="${href}">${label}</a>`)
    }
  })

  it('wraps the body in <main> and only adds the refresh script when asked', () => {
    expect(html).toContain('<main class="page" id="main">\n<section><h2>Body</h2></section>\n</main>')
    expect(html).toContain('const REFRESH = 1000;')
    expect(html).toContain('setInterval(refresh, REFRESH)')
    expect(shell({ title: 't', nav: [], body: '' })).not.toContain('REFRESH')
  })

  it('lets a long stat label widen its column and wrap instead of painting over the value', () => {
    const css = recipesCss()
    const dt = /\.stat dt \{([^}]+)\}/.exec(css)![1]!
    expect(dt).toContain('min-width: 94px;')
    expect(dt).toContain('overflow-wrap: anywhere;')
    expect(css).not.toContain('grid-template-columns: 94px')
  })

  it('has the copy handler on every page, refresh or not, and announces each swap of <main>', () => {
    const still = shell({ title: 't', nav: [], body: '' })
    for (const page of [still, html]) {
      expect((page.match(/ev\.target\.closest\('button\.copy'\)/g) ?? []).length).toBe(1)
      expect(page).toContain("navigator.clipboard.writeText(btn.dataset.copy)")
    }
    expect(still).not.toContain('REFRESH')
    expect(html).toContain('document.dispatchEvent(new Event("samsara:refreshed"))')
    expect(html.indexOf('main.innerHTML = next.innerHTML')).toBeLessThan(html.indexOf('new Event("samsara:refreshed")'))
    expect(REFRESHED_EVENT).toBe('samsara:refreshed')
  })

  it('balances its tags', () => {
    for (const tag of ['html', 'head', 'body', 'header', 'main', 'nav', 'style', 'script', 'title']) {
      expect((html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length, tag).toBe((html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length)
    }
  })
})
