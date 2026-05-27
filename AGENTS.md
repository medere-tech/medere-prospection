# AGENTS.md

> **Source of truth** : ce projet utilise [`CLAUDE.md`](./CLAUDE.md) comme
> référence principale pour tous les agents IA (Claude Code, Cursor, Codex,
> Aider, etc.).
>
> Lis CLAUDE.md AVANT toute action. Tout ce qui suit n'est qu'un complément.

## ⚠️ Next.js 16 — Breaking changes

Cette version de Next.js a des **breaking changes** par rapport aux versions
précédentes. Les patterns que tu pourrais avoir mémorisés (App Router v14/v15,
Turbopack en beta, configuration via fichiers JS, etc.) ne sont plus
nécessairement valides.

**Action obligatoire avant d'écrire du code Next.js** :
1. Consulte la doc embarquée : `node_modules/next/dist/docs/`
2. Vérifie en particulier : routing (`app/`), Server Actions, Server
   Components, `next.config.ts` (oui, `.ts` maintenant), middleware,
   Turbopack par défaut.

## Tailwind CSS v4

Configuration **CSS-first** via la directive `@theme` dans
`src/app/globals.css`. Il n'y a **pas** de `tailwind.config.ts` — c'est
normal et voulu.

## Conventions

Pour tout le reste (stack, commandes, conventions, règles non
négociables, skills, subagents), va lire `CLAUDE.md`.
