# AgencyOS Backend

Study Abroad CRM backend — Node.js + Express + Supabase (PostgreSQL).

## Architecture

```
agency-os-backend/
  src/
    app.js                  Express server (port 3001)
    lib/
      supabase.js           Supabase client (service_role)
      crypto.js             AES-256-GCM encryption for sensitive fields
    middleware/
      auth.js               JWT token verification
    routes/
      auth.js               POST /api/auth/login, /register
      students.js           CRUD + payments (encrypted NID/passport)
      visitors.js           CRUD + convert to student
      attendance.js         GET by date + bulk save
      accounts.js           Income, expenses, payments
      schools.js            CRUD + submissions
      batches.js            CRUD + enroll student
      documents.js          CRUD + field extraction + cross-validation
      hr.js                 Employees + salary
      tasks.js              CRUD
  supabase/
    migrations/
      001_schema.sql        29 tables (full production schema)
      002_indexes.sql       80+ performance indexes
      003_rls.sql           Row Level Security (multi-tenant by agency_id)
      004_storage.sql       4 storage buckets with RLS
      005_auth.sql          Auth triggers, updated_at auto-trigger
      006_seed.sql          Demo agency + sample data
    functions/
      generate-excel/       Edge Function: template + students -> CSV
      cross-validate/       Edge Function: compare fields across docs
```

## Database Schema

**29 tables** organized by module:

| Module | Tables |
|--------|--------|
| Core | agencies, users, activity_log |
| Leads | visitors, agents, communications |
| Students | students, student_education, student_jp_exams, student_family |
| Finance | sponsors, sponsor_banks, payments, payment_installments, expenses |
| Documents | documents, document_fields, excel_templates |
| Schools | schools, submissions |
| Courses | batches, batch_students, attendance, class_tests, class_test_scores |
| Operations | tasks, calendar_events, employees, salary_history, inventory |

## Setup Instructions

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Wait for provisioning to complete
3. Go to **Project Settings > API** and note:
   - `Project URL` (SUPABASE_URL)
   - `service_role` key (SUPABASE_SERVICE_ROLE_KEY)

### 2. Run SQL Migrations

In Supabase Dashboard > **SQL Editor**, run each file **in order**:

```
001_schema.sql      -- Creates all 29 tables
002_indexes.sql     -- Adds performance indexes
003_rls.sql         -- Enables Row Level Security
004_storage.sql     -- Creates storage buckets
005_auth.sql        -- Auth triggers + auto-timestamps
006_seed.sql        -- Demo data (optional)
```

### 3. Enable Auth

In Supabase Dashboard > **Authentication > Providers**:
- Enable **Email** provider
- Disable "Confirm email" for development (optional)

### 4. Configure Backend

```bash
cd agency-os-backend
npm install
cp .env.example .env
```

Edit `.env`:
```env
PORT=3001
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JWT_SECRET=your-random-secret-string
ENCRYPTION_KEY=your-64-char-hex-key
CLIENT_URL=http://localhost:5173
```

Generate encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Start Server

```bash
npm run dev     # Development (with nodemon)
npm start       # Production
```

Server runs at `http://localhost:3001`

### 6. Test

```bash
# Health check
curl http://localhost:3001/api/health

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@agencyos.com","password":"admin123"}'
```

## Multi-Tenancy

Every table has `agency_id` (or inherits it via FK). RLS policies ensure:
- Users can only access data within their own agency
- `current_user_agency_id()` function looks up agency from JWT
- Delete operations restricted to owner/manager roles
- Storage files isolated by `{agency_id}/` folder prefix

## Data Encryption

Sensitive fields are encrypted with **AES-256-GCM** at the application layer:
- NID numbers
- Passport numbers
- Father/Mother names
- Addresses
- Bank account numbers
- Income/balance figures

The `ENCRYPTION_KEY` in `.env` is the master key. **Never commit or share it.**

## API Endpoints

All routes require `Authorization: Bearer <token>` header (except `/api/auth/login`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | Login, returns JWT |
| POST | /api/auth/register | Create staff account |
| GET | /api/students | List (search, filter, paginate) |
| GET | /api/students/:id | Detail with education, exams, sponsor |
| POST | /api/students | Create (auto-encrypts sensitive fields) |
| PATCH | /api/students/:id | Update |
| DELETE | /api/students/:id | Delete |
| GET | /api/visitors | List |
| POST | /api/visitors | Create |
| POST | /api/visitors/:id/convert | Convert to student |
| GET | /api/attendance?date=&batch= | Get by date |
| POST | /api/attendance/save | Bulk save |
| GET | /api/accounts/income | Income list |
| GET | /api/accounts/expenses | Expense list |
| GET | /api/schools | School list |
| GET | /api/batches/:id | Batch detail with enrollments |
| GET | /api/documents | Document list |
| GET | /api/documents/cross-validate/:studentId | Cross-validation |
| GET | /api/hr/employees | Employee list |
| POST | /api/hr/salary | Pay salary |
| GET | /api/tasks | Task list |

## Edge Functions

Deploy with Supabase CLI:

```bash
supabase functions deploy generate-excel
supabase functions deploy cross-validate
```

### generate-excel
```bash
POST /functions/v1/generate-excel
{ "template_id": "uuid", "student_ids": ["S-001", "S-002"] }
# Returns: CSV file
```

### cross-validate
```bash
POST /functions/v1/cross-validate
{ "student_id": "S-001" }
# Returns: { mismatches: [...], total_docs: 5 }
```
