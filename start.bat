@echo off
echo Starting WiFi Voucher backend...
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
call npm start
