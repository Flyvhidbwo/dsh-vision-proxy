#!/usr/bin/env node
/**
 * GitHub PR helper — the ONLY sanctioned way to create/fix PR bodies with
 * CJK text. Body text is read from a UTF-8 file (never passed through shell
 * strings): the Windows GBK console codepage has corrupted bodies repeatedly
 * (see AGENTS.md §3.7). Node fetch + JSON.stringify is always UTF-8.
 *
 * Usage:
 *   node scripts/gh-pr.mjs create <owner/repo> <title> <bodyfile> [head] [base]
 *   node scripts/gh-pr.mjs fix-body <owner/repo> <number> <bodyfile>
 *   node scripts/gh-pr.mjs audit [owner/repo]        # report garbled bodies (?? sequences)
 *
 * Auth: GITHUB_TOKEN env (classic PAT) — required.
 */
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
    console.error('GITHUB_TOKEN env var is required');
    process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
const API = 'https://api.github.com';
const headers = { authorization: `Bearer ${TOKEN}`, 'user-agent': 'dsh-digest', accept: 'application/vnd.github+json' };

async function json(res) {
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return text === '' ? null : JSON.parse(text);
}
function bodyFromFile(path) {
    const fs = require('node:fs');
    return fs.readFileSync(path, 'utf8'); // UTF-8, no BOM handling needed for JSON
}
function isGarbled(s) { return /.{2,4}\?{4,}/.test(s); } // mojibake like ???? in CJK context

async function main() {
    if (cmd === 'create') {
        const [repo, title, bodyFile, head, base = 'main'] = args;
        if (!repo || !title || !bodyFile) throw new Error('create needs <repo> <title> <bodyfile> [head] [base]');
        const body = bodyFromFile(bodyFile);
        const pr = await json(await fetch(`${API}/repos/${repo}/pulls`, {
            method: 'POST', headers, body: JSON.stringify({ title, head, base, body }),
        }));
        console.log(`PR: ${pr.html_url}`);
        (await fetch(pr.comments_url, { headers })); // warm request, not used
    } else if (cmd === 'fix-body') {
        const [repo, number, bodyFile] = args;
        if (!repo || !number || !bodyFile) throw new Error('fix-body needs <repo> <number> <bodyfile>');
        const body = bodyFromFile(bodyFile);
        const pr = await json(await fetch(`${API}/repos/${repo}/pulls/${number}`, {
            method: 'PATCH', headers, body: JSON.stringify({ body }),
        }));
        console.log(`fixed: ${pr.html_url}`);
    } else if (cmd === 'audit') {
        const scope = args[0];
        const q = scope ? `repo:${scope} author:Flyvhidbwo type:pr` : 'author:Flyvhidbwo type:pr';
        const found = [];
        for (let page = 1; page <= 3; page++) {
            const r = await json(await fetch(`${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`, { headers }));
            found.push(...r.items);
            if (r.items.length < 100) break;
        }
        let bad = 0;
        for (const item of found) {
            const repo = item.repository_url.replace('https://api.github.com/repos/', '');
            const pr = await json(await fetch(`${API}/repos/${repo}/pulls/${item.number}`, { headers }));
            if (pr.body && isGarbled(pr.body)) { bad++; console.log(`⚠️ ${repo} #${pr.number}: ${pr.body.slice(0, 60)}`); }
        }
        console.log(`audited ${found.length} PRs, ${bad} garbled${bad === 0 ? ' — all clean' : ''}`);
    } else {
        console.log('usage: create | fix-body | audit');
        process.exit(1);
    }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
