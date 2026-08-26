@echo off
rem Cree weelspin-dist.zip a partir du CONTENU de src\ (aucun build : on zippe, c'est tout)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%~dp0src\*' -DestinationPath '%~dp0weelspin-dist.zip' -Force"
if exist "%~dp0weelspin-dist.zip" (echo OK : weelspin-dist.zip cree.) else (echo ERREUR : le zip n'a pas pu etre cree.)
