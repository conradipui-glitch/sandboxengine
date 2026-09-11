// FIN-01 legacy-database migration CLI.
//
//   node scripts/fin01-legacy-migration.mjs --db <control.sqlite> [--report <file.json>] [--no-backup]
//
// Runs the real store migration (schema only) against a pre-fix control
// database, takes a verified backup first, and writes a report of every release
// and publication record whose authored bundle cannot be proven from stored
// evidence. Records that cannot be proven are reported, never rewritten: no pin
// is invented and no publication record is repointed at the current draft.
//
// Exit codes: 0 = migrated and clean, 2 = migrated but records need an operator
// decision, 1 = failure.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  SQLiteControlStore,
  backupLegacyDatabase,
  inspectLegacyReleaseMigration
} from "../packages/control/dist/index.js";

function parseArgs(argv) {
  const options = { db: null, report: null, backup: null, backupDisabled: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") options.db = argv[++index];
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--backup") options.backup = argv[++index];
    else if (arg === "--no-backup") options.backupDisabled = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("usage: node scripts/fin01-legacy-migration.mjs --db <control.sqlite> [--report <file.json>] [--backup <file>] [--no-backup]");
  process.exit(0);
}
if (!options.db) {
  console.error("fin01-legacy-migration: --db <path> is required");
  process.exit(1);
}
const dbPath = resolve(options.db);
if (!existsSync(dbPath)) {
  console.error(`fin01-legacy-migration: database not found: ${dbPath}`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = options.backup ? resolve(options.backup) : `${dbPath}.pre-fin01-${stamp}.bak`;
const reportPath = options.report ? resolve(options.report) : `${dbPath}.fin01-migration-${stamp}.json`;

let missions;
try {
  if (!options.backupDisabled) {
    const backup = await backupLegacyDatabase({ path: dbPath, backupPath });
    console.log(`backup: ${backup.backupPath} (${backup.bytes} bytes, ${backup.pages} pages, integrity=${backup.integrity})`);
    if (backup.integrity !== "ok") throw new Error("backup failed its integrity check; refusing to migrate");
  } else {
    console.log("backup: skipped (--no-backup)");
  }
  missions = new SQLiteControlStore({ path: dbPath });
  const report = await inspectLegacyReleaseMigration({ path: dbPath, missions });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`schema added: ${report.schema.added.join(", ") || "(nothing)"}`);
  console.log(`releases: ${report.summary.releases} (pinned=${report.summary.pinned} adoptable=${report.summary.adoptable} unprovable=${report.summary.unprovable})`);
  console.log(`publication records: ${report.summary.publications} (reproducible=${report.summary.reproducible} unresolvable=${report.summary.unresolvable} unverified=${report.summary.unverified})`);
  for (const finding of report.releases.filter((entry) => entry.verdict === "unprovable")) {
    console.log(`  UNPROVABLE ${finding.projectId}/${finding.questId}/${finding.releaseId}: ${finding.reason}`);
  }
  for (const finding of report.publications.filter((entry) => entry.verdict === "unresolvable")) {
    console.log(`  UNRESOLVABLE ${finding.projectId}/${finding.questId}/${finding.slug}: ${finding.reason}`);
  }
  console.log(`report: ${reportPath}`);
  process.exitCode = report.clean ? 0 : 2;
} catch (error) {
  console.error(`fin01-legacy-migration: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try { missions?.close(); } catch { /* best effort */ }
}
