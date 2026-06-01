#!/usr/bin/env node
/**
 * setup-firebase-cache.mjs — Self-healing pre-flight pour Firebase emulator.
 *
 * Trois branches déterministes (cf. arbitrage S6.0 Déthié) :
 *
 *   1. `FIREBASE_CACHE_DIR` est défini
 *      → on crée le dossier (mkdir recursive, no-op s'il existe), point.
 *
 *   2. Variable absente ET le home utilisateur contient un caractère
 *      non-ASCII (typiquement "Déthié" sur cette machine Windows)
 *      → on throw avec un message qui indique exactement comment fixer.
 *      Raison : le JAR emulator de Firebase est invoqué par Java, et
 *      certains chemins UTF-8 dans le PATH/CLASSPATH cassent en silence
 *      sur Windows (le download échoue ou Java refuse de loader le jar).
 *
 *   3. Variable absente ET home ASCII pur
 *      → no-op, Firebase utilise son défaut ~/.cache/firebase.
 *      (Cas typique : Mac/Linux, CI GitHub Actions runner.)
 *
 * Ce script est appelé en pretest:firestore et emulator:firestore via
 * npm scripts. Il sort en 0 si tout est OK, en 1 avec stderr explicite
 * si la situation est ambiguë (branche 2 sans variable).
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const NON_ASCII = /[^\x00-\x7F]/u;

function main() {
  const overridden = process.env.FIREBASE_CACHE_DIR;

  if (overridden && overridden.trim().length > 0) {
    const abs = resolve(overridden);
    if (NON_ASCII.test(abs)) {
      // Si l'utilisateur a override mais avec un chemin non-ASCII, on
      // refuse — ça défait l'objectif même de la variable.
      throw new Error(
        `FIREBASE_CACHE_DIR contient un caractère non-ASCII : "${abs}". ` +
          `Choisis un chemin purement ASCII (ex: C:/firebase-cache).`,
      );
    }
    mkdirSync(abs, { recursive: true });
    console.log(`[firebase-cache] OK — utilise ${abs}`);
    return;
  }

  const home = homedir();
  if (NON_ASCII.test(home)) {
    const suggested = process.platform === "win32" ? "C:/firebase-cache" : "/tmp/firebase-cache";
    throw new Error(
      [
        `Home utilisateur contient un caractère non-ASCII : "${home}".`,
        `Le cache Firebase par défaut (~/.cache/firebase) va probablement casser`,
        `le téléchargement du JAR emulator Java sur Windows.`,
        ``,
        `→ Définis FIREBASE_CACHE_DIR dans ton environnement :`,
        ``,
        `   PowerShell (persistant utilisateur) :`,
        `     [Environment]::SetEnvironmentVariable("FIREBASE_CACHE_DIR","${suggested}","User")`,
        ``,
        `   Bash/zsh (session courante) :`,
        `     export FIREBASE_CACHE_DIR=${suggested}`,
        ``,
        `Puis relance la commande. Le script créera le dossier automatiquement.`,
      ].join("\n"),
    );
  }

  // Home ASCII : on laisse Firebase faire son truc.
  const defaultCache = resolve(home, ".cache", "firebase");
  console.log(`[firebase-cache] OK — home ASCII, défaut ${defaultCache} utilisé.`);
  // On ne crée PAS le dossier ici : Firebase s'en occupe au premier download,
  // pas la peine de pré-créer un truc qu'on ne contrôle pas.
  if (!existsSync(defaultCache)) {
    // Juste un log informatif, pas une erreur.
    console.log(`[firebase-cache] (sera créé au premier download)`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[firebase-cache] ERREUR :\n${err.message}`);
  process.exit(1);
}
