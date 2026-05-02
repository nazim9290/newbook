# Zod Input Validation

Schemas live alongside the routes they validate. Each `*.schema.js` file exports one
or more Zod schemas; routes apply them via the `validate(schema, source?)` middleware
factory in `src/middleware/validate.js`.

## Pattern

1. Define a schema (or set of schemas) in `src/schemas/<module>.schema.js`.
2. In the route file, `require` the schema and the `validate` middleware.
3. Wrap the handler: `router.post("/", validate(schema), handler)`.
4. On success, `req.body` (or `req.query` / `req.params`) is the **parsed** value
   — coercions and defaults already applied — so handlers can trust the shape.
5. On failure, the client gets HTTP 400 with:
   ```json
   {
     "error": "ভ্যালিডেশন ত্রুটি",
     "code": "VALIDATION_ERROR",
     "issues": [{ "path": "email", "message": "সঠিক email দিন" }]
   }
   ```

## Adding a new schema

```js
// src/schemas/foo.schema.js
const { z } = require("zod");

const createFooSchema = z.object({
  name: z.string().min(1, "নাম দিন").max(200),
  phone: z.string().regex(/^(\+?88)?01[3-9]\d{8}$/, "ভুল ফোন নম্বর"),
}).strict();

module.exports = { createFooSchema };
```

## Applying a schema

```js
// src/routes/foo.js
const { validate } = require("../middleware/validate");
const { createFooSchema } = require("../schemas/foo.schema");

router.post("/", validate(createFooSchema), asyncHandler(handler));
router.get("/",  validate(listFooQuerySchema, "query"), asyncHandler(handler));
router.get("/:id", validate(idParamSchema, "params"), asyncHandler(handler));
```

## Conventions

- **Bengali messages** for user-facing validators — frontend echoes them verbatim.
- **`.strict()`** on bodies that are 100% known. Use **`.passthrough()`** when the route
  already drops unknown columns via a `VALID_COLS` whitelist.
- **`z.coerce.number()`** for query-string ints (`?page=1&limit=20`).
- For PATCH bodies, build a `studentBase` object first and export
  `studentBase.partial().extend({ updated_at: z.string().datetime().optional() })`
  so optimistic-lock plays nicely.
- Phone (Bangladesh): `/^(\+?88)?01[3-9]\d{8}$/`
- NID: `/^\d{10}$|^\d{13}$|^\d{17}$/`
- Passport: `/^[A-Z]{1,2}\d{6,9}$/i`
- Date string: `z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))`

## Rollout status

`POST /api/auth/login` is wired as the canonical proof-of-concept. The other 59
routes adopt validation incrementally; `auth.js` is the reference shape.
