# Ilmora Marketplace

Bilingual (English / Arabic) digital learning marketplace built with Vite, Supabase and Vercel.

## Features

- Public bilingual catalogue with Arabic RTL layout and category filtering
- Guest checkout and optional customer accounts
- Manual UBA bank transfer and OPay wallet payment submissions
- Administrator payment review before an order is marked paid
- Private digital asset bucket with short-lived signed download links
- Administrator product management, publishing controls and payment account settings

## Setup

1. Install dependencies with `npm install`.
2. Run `npm run dev` for local development.
3. Configure the Supabase project URL and publishable key in `src/main.js` (never put a service-role or secret key in browser code).
4. Deploy `supabase/functions/ilmora-commerce/index.ts` to the Supabase project as the `ilmora-commerce` Edge Function.
5. Apply the SQL migration in `supabase/migrations` to the existing Ilmora schema.
6. Deploy the Vite app to Vercel with `npm run build` and output directory `dist`.

## Payment safety

Customer-submitted transfer references are not proof of payment. An administrator must confirm the incoming funds in the actual UBA / OPay account before approving a payment in the dashboard. Payment accounts remain inactive until an administrator has checked the displayed account details and deliberately activated them. Digital files are delivered only after the order status becomes `paid`.

No Paystack or Flutterwave payment collection is configured in this frontend.
