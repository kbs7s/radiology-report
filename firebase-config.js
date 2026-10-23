// Paste the web app config from Firebase console → Project settings → Your apps → SDK setup and configuration.
// While apiKey is left as "PASTE_API_KEY", the site runs in demo mode: no login, reports stay in this browser only.
export const firebaseConfig = {
  apiKey: "AIzaSyDcDry_7aae2wwuaMcISVHKYX634wUH4ss",
  authDomain: "radiology-report-6ea12.firebaseapp.com",
  projectId: "radiology-report-6ea12",
  storageBucket: "radiology-report-6ea12.firebasestorage.app",
  messagingSenderId: "353717320474",
  appId: "1:353717320474:web:a72baef4cd71e66d0ecaa3",
};

// Printed at the top of every PDF report
export const clinic = {
  name: "Radiology Department",
  subtitle: "MRI · CT · X-Ray",
};
