from pathlib import Path

path = Path("apps/server/src/control-server.ts")
text = path.read_text()

old = '''    if (method === "GET") {\n      const projects = auth\n        ? await auth.security.listProjectsForUser(identity!.user.userId)\n        : await store.listProjects();\n      sendJson(response, 200, { projects });\n      return;\n    }'''
new = '''    if (method === "GET") {\n      if (auth) {\n        const projects = await auth.security.listProjectsForUser(identity!.user.userId);\n        const views = await Promise.all(projects.map(async (project) => {\n          const role = await auth.security.getProjectRole(project.projectId, identity!.user.userId);\n          if (role === null) throw new Error("Control project membership disappeared during project listing");\n          return Object.freeze({ ...project, role });\n        }));\n        sendJson(response, 200, { projects: views });\n      } else {\n        const projects = await store.listProjects();\n        sendJson(response, 200, {\n          projects: projects.map((project) => Object.freeze({ ...project, role: "owner" as const }))\n        });\n      }\n      return;\n    }'''
assert text.count(old) == 1
text = text.replace(old, new, 1)

old = '''      if (result.kind === "created") sendJson(response, 201, { project: result.project });'''
new = '''      if (result.kind === "created") {\n        sendJson(response, 201, { project: Object.freeze({ ...result.project, role: "owner" as const }) });\n      }'''
assert text.count(old) == 1
text = text.replace(old, new, 1)

path.write_text(text)
