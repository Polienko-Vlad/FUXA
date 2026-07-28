@echo off
setlocal
echo ============================================
echo  FUXA: Build Electron App (Windows x64)
echo ============================================

set ROOT=%~dp0

:: Step 1: Server
echo.
echo [1/5] Installing server dependencies...
cd /d "%ROOT%server"
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed for server
    exit /b 1
)

:: Step 2: Client
echo.
echo [2/5] Installing client dependencies...
cd /d "%ROOT%client"
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed for client
    exit /b 1
)

:: Step 3: Build client
echo.
echo [3/5] Building client (production)...
call npx ng build --configuration=production
if %ERRORLEVEL% neq 0 (
    echo ERROR: Client build failed
    exit /b 1
)

:: Step 4: Copy server + client into app/electron
echo.
echo [4/5] Copying server and client to app\electron...

cd /d "%ROOT%"

:: Clean previous copies
if exist "app\electron\server" rmdir /s /q "app\electron\server"
if exist "app\electron\client" rmdir /s /q "app\electron\client"

:: Copy server (excluding node_modules, _appdata, _db, _logs, _reports, _webcam_snapshots)
xcopy "server\*.*" "app\electron\server\" /E /I /Y /Q /EXCLUDE:build-exclude.txt >nul 2>&1
if not exist "app\electron\server\main.js" (
    echo Fallback: using robocopy...
    robocopy "server" "app\electron\server" /E /XD node_modules _appdata _db _logs _reports _webcam_snapshots .git /NFL /NDL /NJH /NJS /NC /NS /NP >nul
)

:: Install server node_modules inside electron copy
echo Installing server dependencies in app\electron\server...
cd /d "%ROOT%app\electron\server"
call npm ci --omit=dev
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed for electron server copy
    exit /b 1
)

:: Copy client dist
cd /d "%ROOT%"
mkdir "app\electron\client\dist" 2>nul
xcopy "client\dist\*.*" "app\electron\client\dist\" /E /I /Y /Q >nul 2>&1
if not exist "app\electron\client\dist\index.html" (
    robocopy "client\dist" "app\electron\client\dist" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul
)

:: Step 5: Install Electron deps and package
echo.
echo [5/5] Packaging Electron app (Windows x64 NSIS)...
cd /d "%ROOT%app\electron"
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed for electron
    exit /b 1
)

call npx electron-builder install-app-deps
call npx electron-builder --win nsis --x64
if %ERRORLEVEL% neq 0 (
    echo ERROR: electron-builder failed
    exit /b 1
)

echo.
echo ============================================
echo  Electron app built: app\electron\dist\
echo ============================================
echo  Look for .exe installer in app\electron\dist\
echo ============================================
