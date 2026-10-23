# طريقة تشغيل موقع تقارير الأشعة

الموقع يتكون من جزئين:

- **الكود:** ينرفع على GitHub Pages، وما بيه أي تقرير.
- **المكتبة والتقارير:** تنحفظ بـ Firebase، وما تنفتح إلا للمستخدمين اللي سجّلوا دخول.

## 1. إعداد Firebase (حوالي 10 دقائق)

1. افتح [Firebase console](https://console.firebase.google.com) واختار مشروعك.
2. من **Project settings ← General ← Your apps** اضغط على أيقونة الويب `</>` وسجّل تطبيق باسم `radiology-report`. بعدها انسخ قيم `firebaseConfig` وحطها بملف `firebase-config.js` بدل `PASTE_API_KEY` والقيم اللي بعدها. وبنفس الملف تكدر تغيّر اسم العيادة اللي يطلع بأعلى ملف PDF.
3. من **Authentication ← Sign-in method** فعّل **Email/Password**.
4. من **Authentication ← Users ← Add user** أضف حساب لكل مستخدم (من 2 إلى 4). انسخ الـ **User UID** لكل واحد.
5. من **Firestore Database ← Create database** اختار **Production mode** وأقرب منطقة إلك.
6. من **Firestore ← Rules** امسح الموجود والصق محتوى ملف `firestore.rules`، وبعدها اضغط **Publish**.
7. من **Firestore ← Data** سوّي مجموعة اسمها `users`. لكل مستخدم أضف وثيقة الـ **Document ID** مالها هو الـ UID مالته، وبيها حقلين:
   - `name` (string): الاسم اللي يطلع بالموقع وبالـ PDF، مثلاً `Dr. Ahmed`.
   - `role` (string): `radiologist` للطبيب الأخصائي (يكتب التقرير ويعتمده)، و`reception` لموظف الاستقبال (يسجّل المريض ويعدّل بياناته بس)، و`staff` لبقية المستخدمين.
8. من **Authentication ← Settings ← Authorized domains** أضف `kbs7s.github.io`.

## 2. النشر على GitHub Pages

1. ارفع ملفات هذا المجلد للمستودع `radiology-report`، **بدون مجلد `data`**.
2. من **Settings ← Pages** اختار **Deploy from a branch**، والفرع `main`، والمجلد `/ (root)`.
3. بعد دقيقة أو دقيقتين يشتغل الموقع على `https://kbs7s.github.io/radiology-report/`.

## 3. رفع المكتبة (مرة وحدة)

1. ادخل للموقع بحساب الطبيب الأخصائي.
2. اضغط **رفع المكتبة** واختار الملفات الستة من مجلد `data`: phrases, next, ngrams, vocab, typos, titles.
3. حدّث الصفحة. راح تطلع لك رسالة «المكتبة: … جملة».

## كيف يشتغل

- **سير العمل:** الاستقبال يضغط «+ مريض جديد» ويعبّي بيانات المريض والفحص (الحالة تصير «بانتظار التقرير»). بعدها الطبيب الأخصائي يفتح المريض، يكتب التقرير (الحالة تصير «مسودة»)، ويعتمده (الحالة «معتمد»). الاستقبال ما يكدر يكتب نص التقرير، والطبيب بس يكدر يعتمد.
- **الحفظ:** كل تقرير ينحفظ تلقائياً بعد ثانية من آخر تعديل. أي مستخدم يكدر يفتح التقرير، والتعديلات توصل للبقية مباشرة.
- **التعديل بنفس الوقت:** إذا شخصين عدّلوا نفس التقرير سوا، يطلع شريط ينبّه عن نسخة أحدث وتكدر تعرضها.
- **الاعتماد:** الطبيب الأخصائي بس يكدر يعتمد التقرير أو يلغي اعتماده، والتقرير المعتمد يتقفل ضد التعديل.
- **ملف PDF:** ينحفظ على الحاسوب والموبايل. إذا التقرير ما معتمد، يطلع بأسفل الملف «DRAFT».
- **زر «صحيحة»:** يضيف الكلمة لقاموس مشترك بين كل المستخدمين.
- **الوضع التجريبي:** إذا ما حطيت إعدادات Firebase، الموقع يشتغل بدون تسجيل دخول، ويقرأ المكتبة من مجلد `data`، ويحفظ التقارير بالمتصفح فقط.

## تحديث المكتبة لاحقاً

```
# 1) استخراج نص التقارير فقط من ملفات Access (أسماء المرضى وهواتفهم ما تنسحب)
cd tools/access-export && mvn -q dependency:copy-dependencies -DoutputDirectory=lib
javac -cp "lib/*" -d classes src/main/java/Reports.java
java -cp "classes:lib/*" Reports <PASSWORD> reports.jsonl path/to/*.accdb

# 2) بناء ملفات المكتبة
pip install openpyxl pyspellchecker
python tools/build_library.py tools/access-export/reports.jsonl data
```

وبعدها ارفع الملفات الجديدة من زر **رفع المكتبة**.
