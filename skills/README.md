# Shared Skills

Skills in this directory are symlinked into both `~/.claude/skills/` and `~/.codex/skills/` by `bin/sync-configs.sh`.

## Adding a new skill

Create a directory named after the skill, with a `SKILL.md` file inside:

```
automations/skills/
└── my-new-skill/
    └── SKILL.md
```

`SKILL.md` should start with YAML frontmatter:

```markdown
---
name: my-new-skill
description: Short description shown in the picker
---

Full instructions for the agent go here…
```

Then run:

```bash
bin/sync-configs.sh
```
