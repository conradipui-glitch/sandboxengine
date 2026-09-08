from pathlib import Path

path = Path("scripts/b10-b10-agent-kit-recipes-sync.py")
text = path.read_text()
old = '''  const packageJson = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(await validateAgentRecipeDefinitions(ROOT, packageJson), true);
'''
new = '''  const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(await validateAgentRecipeDefinitions(root, packageJson), true);
'''
if text.count(old) != 1:
    raise RuntimeError("recipe regression root anchor mismatch")
text = text.replace(old, new, 1)
text = text.replace("validateAgentRecipeDefinitions(ROOT, packageJson, missingPath)", "validateAgentRecipeDefinitions(root, packageJson, missingPath)", 1)
text = text.replace("validateAgentRecipeDefinitions(ROOT, packageJson, existingButUnsafeScript)", "validateAgentRecipeDefinitions(root, packageJson, existingButUnsafeScript)", 1)
old_scripts = 'verificationScripts: Object.freeze(["typecheck", "fixtures:check", "docs:check", "verify"])'
new_scripts = 'verificationScripts: Object.freeze(["typecheck", "test:contracts", "docs:check", "verify"])'
if text.count(old_scripts) != 1:
    raise RuntimeError("migration recipe script anchor mismatch")
text = text.replace(old_scripts, new_scripts, 1)
if text.count('  "fixtures:check",\n') != 1:
    raise RuntimeError("fixtures allowlist anchor mismatch")
text = text.replace('  "fixtures:check",\n', '', 1)
path.write_text(text)
print("B10 recipe staging regressions fixed")
