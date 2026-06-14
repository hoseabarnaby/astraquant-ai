# Deploy AstraQuant AI V46 to GitHub and Vercel

## 1. Test locally

```powershell
cd C:\Users\ASUS\Downloads\astraquant_ai_v46_responsive_redesign
npm install
npm run check
npm start
```

Open `http://localhost:3000`.

## 2. Push to the existing GitHub repository

```powershell
git init
git add .
git commit -m "responsive redesign v46"
git branch -M main
git remote add origin https://github.com/hoseabarnaby/astraquant-ai.git
git push -u origin main --force
```

If `origin` already exists:

```powershell
git remote set-url origin https://github.com/hoseabarnaby/astraquant-ai.git
git push -u origin main --force
```

## 3. Vercel

Vercel should redeploy automatically from branch `main`.

Recommended settings:

- Application Preset: Express
- Root Directory: `./`
- Build Command: None
- Output Directory: N/A
- Install Command: automatic or `npm install`

Keep the existing Supabase environment variables in Vercel. Do not upload `.env` to GitHub.
