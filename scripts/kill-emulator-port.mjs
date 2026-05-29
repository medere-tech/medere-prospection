#!/usr/bin/env node
/**
 * kill-emulator-port.mjs — Workaround BUG-004 (Firestore emulator zombie
 * sur Windows après SIGINT). Cf. CLAUDE.md "Pièges connus" → BUG-004.
 *
 * Comportement VERBEUX par design (décision Déthié S6.1) : tu DOIS voir
 * ce qui se passe, pas de magie. Pas de retry, pas de fix silencieux.
 *
 *   1. `netstat | findstr :8085` (Windows) ou `lsof -i :8085` (Unix).
 *   2. Si pas de match → echo "Port already free" + exit 0.
 *   3. Si match → log les PID(s) identifiés.
 *   4. `taskkill /PID <X> /F` (Windows) ou `kill <X>` (Unix) pour chacun.
 *   5. Confirme à chaque kill.
 *
 * Sur non-Windows : message "BUG-004 est spécifique Windows" et exit 0.
 * (Le bug ne se reproduit pas sur Unix car SIGINT propage au PGID complet.)
 */
import { execSync } from "node:child_process";
import { platform } from "node:os";

const PORT = 8085;

function findListeningPidsWindows() {
  let output = "";
  try {
    output = execSync(`netstat -ano | findstr :${PORT}`, {
      encoding: "utf8",
    });
  } catch {
    // findstr exit 1 quand aucun match — c'est le cas nominal "port libre".
    return [];
  }
  // Format ligne netstat Windows :
  //   "  TCP    127.0.0.1:8085   0.0.0.0:0   LISTENING       33992"
  // On garde uniquement les lignes LISTENING (les ESTABLISHED/TIME_WAIT
  // sont des connexions résiduelles qui se ferment toutes seules).
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const status = cols[3];
    if (status !== "LISTENING") continue;
    const pid = cols[cols.length - 1];
    if (/^\d+$/.test(pid)) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function killWindows(pid) {
  console.log(`[emulator:kill] Killing PID ${pid} (taskkill /PID ${pid} /F)…`);
  execSync(`taskkill /PID ${pid} /F`, { encoding: "utf8" });
  console.log(`[emulator:kill] ✓ PID ${pid} killed.`);
}

function main() {
  const plat = platform();

  if (plat !== "win32") {
    console.log(`[emulator:kill] Plateforme ${plat} — BUG-004 est spécifique Windows.`);
    console.log(
      `[emulator:kill] Sur Unix : \`lsof -i :${PORT}\` pour identifier, ` +
        `\`kill <pid>\` si nécessaire. Rien à faire ici.`,
    );
    return;
  }

  console.log(`[emulator:kill] Scanning :${PORT} (Windows netstat)…`);
  const pids = findListeningPidsWindows();

  if (pids.length === 0) {
    console.log(`[emulator:kill] ✓ Port ${PORT} already free.`);
    return;
  }

  console.log(`[emulator:kill] Found ${pids.length} zombie PID(s) on :${PORT}: ${pids.join(", ")}`);
  for (const pid of pids) {
    killWindows(pid);
  }
  console.log(`[emulator:kill] Done. Port ${PORT} should now be free.`);
}

try {
  main();
} catch (err) {
  console.error(`[emulator:kill] ERREUR : ${err.message}`);
  process.exit(1);
}
