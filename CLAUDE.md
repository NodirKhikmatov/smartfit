# Smart Fit — loyiha qoidalari

- Kiosk orqali kiyim tavsiya qiluvchi tizim (kiyim do'konlari uchun). Full spec: `docs/SPEC.md`.
- Stack: Node.js 22 + Express, PostgreSQL (dev: SQLite), vanilla JS frontend.
- Interfeys tili: o'zbek (lotin). Kod va izohlar: ingliz.
- ASOSIY QOIDA: faqat do'konda bor va qoldig'i > 0 kiyim taklif qilinadi va sotiladi.
- Mijoz rasmi diskka, bazaga yoki loglarga saqlanmaydi.
- Har yangi funksiya uchun test yoziladi (`node --test`, run via `npm test`).
- Maxfiy kalitlar faqat `.env` faylida, kodda emas.
- Narxlar so'mda, butun son. Jami summani doim server hisoblaydi.

## How sessions work
The build is split into tasks in `TASKS.md`. Each task runs in its own Claude Code session. Do only the task you were given, and don't start the next one.

Every session follows this cycle:
1. **Plan**: read `TASKS.md`, `docs/SPEC.md` and the existing code. Present a plan and **wait for the user's approval** before writing any code.
2. **Code**: implement the approved plan.
3. **Test**: `npm test` must pass. Every "done when" check of the task has a test, or a written note for a manual check.
4. **Review**: review this task's changes for bugs and security issues, and fix what you find.
5. **Save**: tick the task in `TASKS.md`, add a short "Notes" line under it (what was done, and anything manual or deferred), then `git commit`.
