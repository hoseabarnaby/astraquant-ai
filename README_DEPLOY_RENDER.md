# AstraQuant AI V42 — Render Upload Pack

Folder ini sudah disiapkan supaya kamu tidak salah upload.

## Isi penting

```text
server.js                 backend Node/Express
public/                   frontend
package.json              start script sudah benar
.gitignore                mencegah .env dan node_modules ikut upload
.env.example              contoh env lokal
render.yaml               optional blueprint Render
supabase_schema.sql       SQL Supabase kalau tabel belum ada
01_RUN_LOCAL_FIRST.bat    tes lokal sekali klik
UPLOAD_TO_GITHUB_COMMANDS.txt
RENDER_ENV_COPY_THIS.txt
```

## Yang JANGAN diupload

```text
.env
node_modules/
```

File `.gitignore` sudah disiapkan supaya dua itu tidak ikut masuk GitHub.

## Start command

```bash
npm start
```

## Build command

```bash
npm install
```

## Environment variables untuk Render

Lihat file:

```text
RENDER_ENV_COPY_THIS.txt
```

## Local test

Double click:

```text
01_RUN_LOCAL_FIRST.bat
```

atau manual:

```powershell
npm install
npm run check
npm start
```
