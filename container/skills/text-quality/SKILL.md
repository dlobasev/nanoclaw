---
name: text-quality
description: Shared text-quality standard for all writing agents. Load text-standard.md as the single source of truth for what a good text is, then the role file — author-agent.md when you are writing, reviewer-agent.md when you are reviewing. Use whenever an agent drafts or reviews a post, article, email, or landing copy.
---

# text-quality — общий стандарт качества текста

Единый источник правды для письма и ревью, общий для всех пишущих агентов и доступный любому агенту (включая Юну) по запросу. Живёт в одном месте (`/app/skills/text-quality/`), версионируется в git.

## Файлы

- **`text-standard.md`** — блоки 1–8, каждый пункт с вердиктом PASS / WARN / FAIL. Единый стандарт «что такое хороший текст». Читается ПЕРВЫМ обеими ролями. В конце — Changelog правок.
- **`author-agent.md`** — роль автора: протокол написания 0–7 (фактура → одна мысль → эмоция/валюта → арка/вход → скелет → черновик → самопроверка → выдача) + жёсткие правила. Автор читает стандарт как требования: FAIL-критерий = запрет, PASS = обязательное свойство.
- **`reviewer-agent.md`** — роль ревьюера: порядок проверки, правило вердикта (ПУБЛИКОВАТЬ / ПРАВИТЬ / ПЕРЕПИСАТЬ), формат отчёта. Ревьюер читает стандарт буквально как проверки.

## Как подключать (конкатенация ролей)

- **Пишешь текст:** прочитай `text-standard.md` + `author-agent.md`, дальше по протоколу 0–7. Формат (`social` / `blog` / `email` / `landing`) — параметр задания.
- **Ревьюишь текст:** подними независимого сабагента-ревьюера, дай ему прочитать `text-standard.md` + `reviewer-agent.md` плюс канонический контекст канала (голос, ограничения, корпус последних постов того же формата) и сводку решений автора. Верни отчёт по формату из `reviewer-agent.md`.

Стандарт — то, что проверяется; роль — как проверять/писать. Контент существует один раз, роли интерпретируют его по-своему. Абсолютные пути в контейнере: `/app/skills/text-quality/text-standard.md`, `/app/skills/text-quality/author-agent.md`, `/app/skills/text-quality/reviewer-agent.md`.
