# Palm Deposit System

نظام Backend + صفحة بسيطة لتعبئة رصيد USDT وربطها بـ NOWPayments.

## مهم قبل التشغيل الحقيقي
- لا تضع API Key أو IPN Secret في الواجهة.
- هذا المشروع يستخدم SQLite للتجربة/البداية؛ للإنتاج يمكن نقله إلى PostgreSQL.
- وضع `DEPOSIT_ADDRESS_MODE=permanent` يفترض أن حساب NOWPayments لديه ميزة Permanent Deposit Addresses/partner أو Casino API مفعلة. NOWPayments يصف هذه الميزة كحل لشركاء iGaming، بينما الدفع العادي يولد عناوين ديناميكية.
- لا تعتمد على إدخال المستخدم لتأكيد الدفع. الرصيد لا يُضاف إلا من IPN موقع ومتحقق منه، وبحماية idempotency عبر TX hash/credited_amount.

## التشغيل
```bash
cd api
cp .env.example .env
npm install
# ضع المفاتيح في .env
npm start
```
ثم افتح `web/index.html` عبر سيرفر الواجهة، واضبط `BASE_URL` ليكون رابط الـBackend العام.

## NOWPayments
1. ضع API Key في `NOWPAYMENTS_API_KEY`.
2. ضع IPN Secret في `NOWPAYMENTS_IPN_SECRET`.
3. اجعل `BASE_URL` رابط HTTPS عام للـBackend.
4. استخدم `/api/webhooks/nowpayments` كـ IPN callback.
5. اختبر أولًا في sandbox/بيئة اختبار قبل الأموال الحقيقية.

## API
- `GET /api/health`
- `GET /api/users/:userId/deposit-address?currency=usdttrc20`
- `POST /api/deposits` body: `{userId,currency,amount}`
- `POST /api/webhooks/nowpayments`
- `GET /api/users/:userId/balance`
- `GET /api/users/:userId/deposits`
