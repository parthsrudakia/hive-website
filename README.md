# Hive — City Living, Made Simple

A real estate listing platform for furnished, flexible-lease apartments. Built with Node.js, Express, EJS, and PostgreSQL.

**Live site:** https://hive-app-production-6bea.up.railway.app
**Custom domain:** https://hiveny.com (once DNS is configured)

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Templates:** EJS (server-side rendered)
- **Database:** PostgreSQL
- **Hosting:** Railway (app + database)
- **Domain:** Namecheap (hiveny.com)
- **Images:** Google Drive links (not local file storage)
- **Email:** Nodemailer via Gmail SMTP

---

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL 14+

### Local Setup

```bash
# 1. Clone the repo
git clone <repo-url>
cd saverasTest

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your database URL, SMTP credentials, etc.

# 4. Initialize the database (creates tables automatically on first run)
node server.js

# 5. Seed sample data (optional — creates admin user + sample listings)
node db/seed.js

# 6. Open http://localhost:3000
```

### Admin Access
- **URL:** `/admin`
- **Login:** `admin@hiveny.com` — the password is set when seeding
  (`ADMIN_SEED_PASSWORD=<your-password> node db/seed.js`, or a random one is
  generated and printed once).
- Change it any time from **/admin/account**, or use the login page's
  **Forgot password?** link (emails a reset link to the site owner).

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Random string for session encryption |
| `SMTP_USER` / `SMTP_PASS` | Yes | Gmail credentials for form notifications |
| `GOOGLE_API_KEY` | No | Google Drive API key for bulk image imports |
| `GOOGLE_PLACES_API_KEY` | No | Google Places API for reviews widget |
| `GOOGLE_PLACE_ID` | No | Google Maps Place ID for reviews |

---

## Project Structure

```
saverasTest/
├── server.js              # Express app entry point + DB migrations
├── db/
│   ├── pool.js            # PostgreSQL connection pool
│   ├── init.js            # Schema initialization
│   └── seed.js            # Sample data seeder
├── middleware/
│   └── auth.js            # Admin authentication guard
├── routes/
│   ├── public.js          # Public pages (home, properties, apply, partners)
│   ├── admin.js           # Admin panel (listings CRUD, bookings, applications)
│   └── api.js             # JSON API (listing search, transit lookup)
├── utils/
│   └── googleReviews.js   # Google Places API integration
├── views/
│   ├── public/            # Public-facing EJS templates
│   └── admin/             # Admin panel EJS templates
├── public/
│   ├── images/            # Static images (team photos)
│   └── uploads/           # File uploads (ephemeral on Railway)
├── package.json
├── .env.example
└── README.md
```

---

## Routes

### Public
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Homepage with featured listings |
| GET | `/properties` | All listings with filters |
| GET | `/properties/:id` | Individual listing detail |
| GET | `/partners` | Partners/landlords page |
| GET/POST | `/apply` | Tenant application form |
| GET/POST | `/partners/apply` | Landlord inquiry form |

### Admin (requires login)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/dashboard` | Listings overview with filters |
| GET | `/admin/listings/new` | Create new listing |
| GET | `/admin/listings/:id/edit` | Edit listing |
| POST | `/admin/listings/:id/delete` | Delete listing |
| GET | `/admin/applications` | View tenant applications |
| GET | `/admin/landlord-inquiries` | View landlord inquiries |
| GET | `/admin/bookings` | View all bookings |

### API
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/listings` | JSON listings with filters |
| GET | `/api/transit?address=` | Transit station lookup |

---

## Database

Tables are auto-created on startup via migrations in `server.js`. Key tables:

- **listings** — Property listings with images, amenities, pricing
- **bookings** — Date reservations per listing
- **applications** — Tenant application submissions
- **landlord_inquiries** — Landlord partnership inquiries
- **admin_users** — Admin login credentials (bcrypt hashed)
- **session** — Express session storage

---

## Deployment (Railway)

The app is deployed on Railway with automatic builds.

```bash
# Deploy from the project directory
cd saverasTest
railway up --detach
```

Railway provides:
- PostgreSQL database (auto-configured via `DATABASE_URL`)
- HTTPS with auto-SSL
- Custom domain support

### Environment Variables on Railway
Set via Railway dashboard or CLI:
```bash
railway variables set KEY=value
```

---

## Image Management

Images are stored as **Google Drive URLs** in the database. Do NOT use the file upload feature for production images — Railway's filesystem is ephemeral (files are lost on redeploy).

### Adding images to a listing:
1. Upload images to a Google Drive folder
2. Set folder sharing to "Anyone with the link"
3. In the admin listing editor, paste the folder link to import all images
4. Or paste individual file links one at a time

---

## Email Notifications

When someone submits a tenant application or landlord inquiry:
1. The submission is saved to the database
2. An email notification is sent to `Vdutta1485@hotmail.com` (hardcoded in `routes/public.js`)
3. To change the recipient, update the email address in `routes/public.js`

---

## Known Limitations

1. **Ephemeral file storage** — Files uploaded via the admin form don't persist on Railway. Use Google Drive links instead.
2. **No CSRF protection** — Forms don't have CSRF tokens. Consider adding `csurf` middleware.
3. **Single admin** — Only one admin account. Multi-user support would require role management.
4. **Hardcoded email recipient** — Notification emails go to a hardcoded address in the route files.
5. **No automated backups** — Railway PostgreSQL should be backed up periodically.

---

## Design System

### Colors
| Name | Hex | Usage |
|------|-----|-------|
| Ink | `#1a1a18` | Text, dark backgrounds |
| Cream | `#f5f2ed` | Page backgrounds |
| Warm | `#e8e3db` | Section backgrounds |
| Honey Gold | `#d4920b` | Accent color (badges, buttons, highlights) |
| Dark Honey | `#b87d09` | Hover states |

### Fonts
- **Headings:** Cormorant Garamond (serif)
- **Body:** DM Sans (sans-serif)
