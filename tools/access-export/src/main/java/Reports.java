import com.healthmarketscience.jackcess.*;
import com.healthmarketscience.jackcess.crypt.CryptCodecProvider;
import com.google.gson.*;
import java.io.*;
import java.util.*;
import java.util.regex.Pattern;

// Exports only report text and exam fields from PDATA. Patient name, phone, age, price and
// referring doctor are never written; any patient-name words found inside the text are masked.
public class Reports {
  public static void main(String[] a) throws Exception {
    String pw = a[0];
    Gson gson = new Gson();
    int total = 0, masked = 0;
    try (PrintWriter out = new PrintWriter(new OutputStreamWriter(new FileOutputStream(a[1]), "UTF-8"))) {
      for (int i = 2; i < a.length; i++) {
        String month = new File(a[i]).getName();
        try (Database db = new DatabaseBuilder(new File(a[i])).setReadOnly(true).setCodecProvider(new CryptCodecProvider(pw)).open()) {
          for (Row r : db.getTable("PDATA")) {
            Object txt = r.get("RTXT");
            if (txt == null || txt.toString().trim().isEmpty()) continue;
            String text = txt.toString();
            Object pn = r.get("PName");
            if (pn != null) {
              for (String part : pn.toString().trim().split("\\s+")) {
                if (part.length() < 3) continue;
                Pattern p = Pattern.compile("(?i)(?<![\\p{L}])" + Pattern.quote(part) + "(?![\\p{L}])");
                if (p.matcher(text).find()) { text = p.matcher(text).replaceAll("[NAME]"); masked++; }
              }
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("source", month);
            m.put("testType", str(r.get("TestType")));
            m.put("contrast", str(r.get("Contrast")));
            m.put("date", str(r.get("DT")));
            m.put("text", text);
            out.println(gson.toJson(m));
            total++;
          }
        }
      }
    }
    System.out.println("reports=" + total + " nameWordsMasked=" + masked);
  }
  static String str(Object o) { return o == null ? null : o.toString(); }
}
