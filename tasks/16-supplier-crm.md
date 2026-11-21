# Task 16: Supplier requests, communication log and AI categorization

**Branch:** `feat/supplier-crm` · Part B of the demo plan (tasks 3 and 4), plus the AI categorization

## Why

Pricing a bill means asking suppliers for quotes. We need to know which suppliers deliver what a bill contains, send
each of them **one** email for all their positions, and keep track of who answered, how fast, and whom to chase.

## What was built

1. **Data** (`db/migrations/020_supplier_crm.sql`):
   - `supplier_category`: the categories a supplier delivers, on top of the categories of its catalogue products.
   - `communication`: every contact with a supplier or subcontractor (`rfq_sent`, `reply`, `offer_received`,
     `reminder_sent`, `call`, `note`), with bill, subject, the positions asked for, due date and `answered_at`.
   - `reminder`: follow-ups, created automatically when a request goes out.
   - `position_category`: the category of a bill position, with source `user`, `ai` or `keyword` and a confidence.
2. **Backend** (`backend/crm.py`, routes `/api/crm/*`, see `docs/API.md`):
   - Category of a position. Your own choice wins. Next comes the category of the linked catalogue product, then the
     AI's choice.
   - **AI categorization** of positions without a category. Claude (`claude-haiku-5-5`, or `BILLBUILD_CATALOGUE_MODEL`)
     chooses one catalogue category or "none" (labour only), using example products per category. It runs in batches
     of 40, four at a time. Without `ANTHROPIC_API_KEY`, or when a batch fails, a keyword matcher runs instead.
     It weights rare words, stems German words and matches compounds (Rohr, Rohre, Rohrleitung, Transportbeton).
   - Log: an answer links itself to the party's latest open request, takes over its bill, closes it, and closes its
     reminders. A chaser moves the reminder two days on. Deleting an answer reopens the request.
   - Overview: per supplier and subcontractor, the number of requests, the answer rate, the average response time,
     the open and overdue requests, and the last contact.
3. **Frontend**:
   - **Export → Request quotes from suppliers…** (`components/quotes/RequestQuotesOverlay.tsx`):
     - Positions are grouped by category, with the source and confidence shown. The category can be changed in place,
       and the AI runs for the open positions.
     - Each supplier gets one card listing all its positions. The email can be opened in the mail app, downloaded as
       `.eml` (automatic when the link would exceed about 1,900 characters), copied, or downloaded together with the
       others as `.zip`.
     - Opening or downloading an email logs `rfq_sent`, with the due date and a reminder.
   - **Requests page** (`/requests`, sidebar):
     - Totals and reminders that are due. From a reminder you can log an offer or reply, send a reminder email, snooze
       it, or mark it done.
     - Contacts table, with a detail dialog for categories, logging a contact, adding reminders and the history.
   - Subcontractor packages (`SubcontractOverlay`) log `rfq_sent` on export and `offer_received` on "offer received".

## Limits

- "Sent" means the email was opened in the mail app or downloaded. BillBuild cannot see whether it actually went out.
  The UI says so.
- Replies are logged by hand. There is no mailbox integration.

## Tests

- `backend/tests/test_crm.py`: keyword fallback, AI constraints, priority of the category sources, fallback after
  model errors, request, answer and reminder life cycle. Needs `CATALOGUE_TEST_DSN`.
- `frontend/tests/crm.test.ts`: grouping by supplier, email text, mailto limit, `.eml` draft.
