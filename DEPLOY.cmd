@echo off
setlocal
rem Double-click to publish: pushes this folder's saved commits to GitHub,
rem which rebuilds https://derinyesudas.github.io/cv-generator/ in a minute or two.
cd /d "%~dp0"
echo Commits waiting to go live:
git log --oneline origin/main..HEAD
echo.
git push origin main
if errorlevel 1 goto fail
echo.
echo PUSHED. The site updates in a minute or two:
echo   https://derinyesudas.github.io/cv-generator/
echo Progress: https://github.com/derinyesudas/cv-generator/actions
echo.
goto done
:fail
echo.
echo FAILED - read the message above.
:done
pause
