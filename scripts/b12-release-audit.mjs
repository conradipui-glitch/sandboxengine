import { spawnSync } from "node:child_process";

function runAudit(args) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "audit", "--json", ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });

  if (!result.stdout.trim()) {
    throw new Error(`npm audit produced no JSON output: ${result.stderr.trim() || `exit ${result.status}`}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm audit returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (parsed.error) {
    throw new Error(`npm audit failed: ${JSON.stringify(parsed.error)}`);
  }

  return parsed;
}

function advisorySummary(audit) {
  const entries = Object.entries(audit.vulnerabilities ?? {}).map(([name, item]) => ({
    name,
    severity: item.severity,
    direct: Boolean(item.isDirect),
    range: item.range ?? null,
    effects: Array.isArray(item.effects) ? item.effects : [],
    nodes: Array.isArray(item.nodes) ? item.nodes : [],
    fixAvailable: item.fixAvailable ?? false,
    via: Array.isArray(item.via)
      ? item.via.map((via) => typeof via === "string" ? via : {
          source: via.source ?? null,
          name: via.name ?? null,
          dependency: via.dependency ?? null,
          title: via.title ?? null,
          url: via.url ?? null,
          severity: via.severity ?? null,
          range: via.range ?? null
        })
      : []
  }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function counts(audit) {
  const v = audit.metadata?.vulnerabilities ?? {};
  return {
    info: Number(v.info ?? 0),
    low: Number(v.low ?? 0),
    moderate: Number(v.moderate ?? 0),
    high: Number(v.high ?? 0),
    critical: Number(v.critical ?? 0),
    total: Number(v.total ?? 0)
  };
}

const all = runAudit([]);
const production = runAudit(["--omit=dev"]);
const allCounts = counts(all);
const productionCounts = counts(production);

const report = {
  gate: "B12.3-release-audit",
  allDependencies: {
    counts: allCounts,
    advisories: advisorySummary(all)
  },
  productionDependencies: {
    counts: productionCounts,
    advisories: advisorySummary(production)
  },
  policy: {
    failOnCriticalAnywhere: true,
    failOnProductionHighOrCritical: true,
    devOnlyHighRequiresReleaseReportTriage: true
  }
};

console.log(JSON.stringify(report));

if (allCounts.critical > 0) {
  console.error("release audit failed: critical vulnerability exists in dependency graph");
  process.exit(1);
}
if (productionCounts.high > 0 || productionCounts.critical > 0) {
  console.error("release audit failed: high/critical vulnerability exists in production dependency graph");
  process.exit(1);
}
