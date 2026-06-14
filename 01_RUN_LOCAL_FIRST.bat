@echo off
title AstraQuant AI V46 Responsive Redesign
echo ==========================================
echo   AstraQuant AI V46 Responsive Redesign
echo ==========================================
echo.
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)
call npm run check
if errorlevel 1 (
  echo Syntax check failed.
  pause
  exit /b 1
)
echo.
echo Open: http://localhost:3000
call npm start
pause
