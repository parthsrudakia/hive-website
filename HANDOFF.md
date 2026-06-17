# Hive — Site Handoff Guide

This document explains everything you need to know about the Hive website, how it works, what it costs, and how to hand it off to a new developer.

---

## What Is This Site?

Hive is a website for listing furnished, flexible-lease apartments. It has:

- **A public website** where people can browse available apartments, view photos and details, and apply to rent
- **An admin panel** where you can add/edit/remove apartment listings, view tenant applications, and manage bookings
- **Automatic email notifications** — when someone fills out the tenant application or landlord inquiry form, an email is sent to Vdutta1485@hotmail.com

The site is live at: **https://hiveny.com** (or https://hive-app-production-6bea.up.railway.app)

---

## What Does It Cost?

| Service | Cost | What It Does |
|---------|------|--------------|
| **Railway** (hosting) | ~$5/month (Hobby plan) | Runs the website and database |
| **Namecheap** (domain) | ~$10–15/year | Owns the hiveny.com web address |
| **Google Cloud** (APIs) | Free (within free tier) | Powers the Google Drive image imports |
| **Gmail** (email) | Free | Sends email notifications when forms are submitted |

**Total: roughly $6–7/month**

---

## How to Access the Admin Panel

1. Go to **hiveny.com/admin** (or the Railway URL + /admin)
2. Log in with:
   - **Email:** admin@hiveny.com
   - **Password:** hiveny2026
3. From the dashboard you can:
   - Add new apartment listings
   - Edit or delete existing listings
   - View tenant applications
   - View landlord inquiries
   - Manage bookings

**Important:** Change the admin password after handoff for security.

---

## How Images Work

The site does **not** store images on the server. Instead, all apartment photos are hosted on **Google Drive** and linked by URL.

To add images to a listing:
1. Upload photos to a Google Drive folder
2. Right-click the folder → Share → set to **"Anyone with the link"**
3. In the admin listing editor, paste the Google Drive folder link
4. Click "Import from Drive" — all images from the folder will be added

You can also paste individual Google Drive image links one at a time.

---

## What a New Developer Needs

To work on this site, a developer will need access to:

### 1. The Code (GitHub)
- The full source code is on GitHub
- Give the developer access to the repository (invite them as a collaborator)
- They can clone it, make changes, and deploy

### 2. Railway Account (Hosting)
- **Sign in at:** https://railway.com
- This is where the website and database run
- The developer will need access to the Railway project to deploy updates and manage environment variables
- You can invite them as a team member on Railway

### 3. Namecheap Account (Domain)
- **Sign in at:** https://namecheap.com
- This controls the hiveny.com domain name
- The developer only needs this if the domain name or DNS settings need to change

### 4. Environment Variables
These are secret settings the site needs to run. They're stored on Railway (not in the code). A developer can view them in the Railway dashboard. The key ones are:

| Variable | What It Is |
|----------|-----------|
| `DATABASE_URL` | Connection to the database (Railway sets this automatically) |
| `SESSION_SECRET` | A random string that keeps admin logins secure |
| `SMTP_USER` | The Gmail address used to send notification emails |
| `SMTP_PASS` | The Gmail app password (not your regular Gmail password) |
| `GOOGLE_API_KEY` | API key for importing images from Google Drive folders |
| `GOOGLE_PLACES_API_KEY` | API key for showing Google reviews on the homepage |
| `GOOGLE_PLACE_ID` | Your Google Maps business listing ID |

### 5. Google Cloud Console (Optional)
- **Sign in at:** https://console.cloud.google.com
- This is where the API keys are managed
- Only needed if the Google Drive import or Google Reviews features stop working

---

## How to Deploy Changes

When a developer makes changes to the code, they deploy (publish) the update like this:

1. Make code changes locally
2. Open a terminal in the project folder
3. Run: `railway up --detach`
4. The site updates within a few minutes

The developer will need the Railway CLI tool installed and be logged into the Railway account.

---

## How to Find a Developer

You're looking for a **web developer** or **full-stack developer** who knows:
- **Node.js** and **Express** (the language and framework the site is built with)
- **PostgreSQL** (the database)
- **EJS templates** (the HTML templating system)
- Basic **CSS** and front-end skills

Good places to find developers:
- **Upwork** (upwork.com) — freelancers, good for ongoing small tasks
- **Toptal** (toptal.com) — vetted developers, higher quality but more expensive
- **LinkedIn** — post a job or search for freelancers
- **Personal referrals** — ask around your network

**What to tell them:**
> "I have a Node.js/Express website hosted on Railway with a PostgreSQL database. The code is on GitHub. I need someone to make updates and maintain it. The codebase has a README with full setup instructions."

**Budget expectations:**
- Small changes (copy updates, styling tweaks): $50–200 per task
- Medium features (new pages, form changes): $200–800
- Ongoing maintenance retainer: $200–500/month depending on scope

---

## Common Tasks and How They're Done

| Task | How |
|------|-----|
| **Add a new listing** | Admin panel → New Listing → fill in details → save |
| **Edit a listing** | Admin panel → click the listing → edit → save |
| **Change photos** | Upload to Google Drive → share folder → paste link in admin |
| **Mark a unit as rented** | Edit listing → change status to "Rented" |
| **Change notification email** | A developer needs to update the email address in the code (`routes/public.js`) |
| **Update site copy/text** | A developer edits the template files in `views/public/` |
| **Change colors or styling** | A developer edits the CSS in the template files |
| **Add a new page** | A developer creates a new template and route |

---

## DNS Setup (hiveny.com)

The domain hiveny.com needs to point to Railway. In Namecheap:

1. Log into Namecheap → Domain List → hiveny.com → Manage
2. Go to **Advanced DNS**
3. Add (or update) a **CNAME Record**:
   - **Host:** `@` (or leave blank for root domain)
   - **Value:** `kfviehjc.up.railway.app`
   - **TTL:** Automatic
4. For `www.hiveny.com`, add another CNAME:
   - **Host:** `www`
   - **Value:** `kfviehjc.up.railway.app`
   - **TTL:** Automatic

Note: The www version requires Railway's Hobby plan ($5/month) to add a second custom domain.

---

## What to Hand Over (Checklist)

When you're ready to bring on a new developer, give them:

- [ ] **GitHub repository access** — invite them as a collaborator
- [ ] **Railway account access** — add them to the project team
- [ ] **This document** (HANDOFF.md) — overview of everything
- [ ] **README.md** (in the code repo) — technical setup instructions
- [ ] **Namecheap login** (only if DNS changes are needed)
- [ ] **Google Cloud Console access** (only if API keys need updating)

---

## Important Notes

1. **Don't upload images through the file picker in the admin panel** — those files get deleted every time the site redeploys. Always use Google Drive links.
2. **Back up the database periodically** — Railway doesn't do automatic backups on the free/hobby plan. A developer can set this up.
3. **The Gmail app password** (SMTP_PASS) is not your regular Gmail password. It's a special "App Password" generated in Gmail settings. If it stops working, you'll need to generate a new one.
4. **The admin password** should be changed after handoff. A developer can update it in the database.

---

*Last updated: March 2026*
