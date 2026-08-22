# My Messenger

Simple HTML/CSS/JavaScript messenger using Supabase.

## 1. Supabase

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `schema.sql`.
4. In `script.js`, set:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`

Never put a Supabase Secret Key in this frontend.

## 2. GitHub

Upload these files to your repository:

- index.html
- style.css
- script.js
- schema.sql

## 3. Vercel

Import the GitHub repository into Vercel and deploy it as a static site.

## 4. Current features

- Register / Login
- User profiles
- User search
- Private 1-to-1 chats
- Realtime messages
- Online presence
- Edit own messages
- Delete own messages
- Responsive UI

## Note

For production, add stronger username validation, rate limiting, file uploads, message read receipts, groups, moderation, and more restrictive policies as the app grows.
