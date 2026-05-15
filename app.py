from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from dotenv import load_dotenv
import openai, base64, json, os, math

load_dotenv()

app = Flask(__name__)
CORS(app)

# Groq uses the OpenAI-compatible SDK — just different base_url + key
client = openai.OpenAI(
    api_key=os.environ.get("GROQ_API_KEY"),
    base_url="https://api.groq.com/openai/v1"
)

# ── grade tables ──────────────────────────────────────────────────────────────
GRADE_GP = {"O": 10, "A+": 9, "A": 8, "B+": 7, "B": 6, "C": 5, "P": 4, "F": 0}
GP_GRADE = {10: "O", 9: "A+", 8: "A", 7: "B+", 6: "B", 5: "C", 4: "P", 0: "F"}

def marks_to_gp(m):
    m = float(m)
    if m >= 90: return 10
    if m >= 82: return 9
    if m >= 72: return 8
    if m >= 62: return 7
    if m >= 55: return 6
    if m >= 45: return 5
    if m >= 40: return 4
    return 0

# ── core calculation ──────────────────────────────────────────────────────────
def compute_subject(subj):
    credits   = int(subj.get("credits", 4))
    is_abs    = bool(subj.get("isAbsolute", False))
    has_lab   = bool(subj.get("hasLab", False))
    lab_marks = subj.get("labMarks")

    # --- absolute grading (1–2 cr subjects with raw marks) ---
    if is_abs:
        raw_marks = float(subj.get("leMarks") or subj.get("leGrade") or 0)
        gp = marks_to_gp(raw_marks)
        return {
            "finalGP": gp,
            "grade": GP_GRADE.get(gp, "—"),
            "working": {"type": "absolute", "marks": raw_marks, "finalGP": gp}
        }

    # --- relative grading ---
    s1_grade = subj.get("s1Grade") or ""
    s2_grade = subj.get("s2Grade") or ""
    le_grade = subj.get("leGrade") or ""

    # If leGrade is numeric it means the AI put a number there — treat as absolute
    if le_grade and str(le_grade).replace('.','').isdigit():
        gp = marks_to_gp(float(le_grade))
        return {
            "finalGP": gp,
            "grade": GP_GRADE.get(gp, "—"),
            "working": {"type": "absolute_auto", "marks": float(le_grade), "finalGP": gp}
        }

    s1 = GRADE_GP.get(str(s1_grade).strip())
    s2 = GRADE_GP.get(str(s2_grade).strip())
    le = GRADE_GP.get(str(le_grade).strip())

    missing = []
    if s1 is None: missing.append(f"S1({s1_grade!r})")
    if s2 is None: missing.append(f"S2({s2_grade!r})")
    if le is None: missing.append(f"LE({le_grade!r})")
    if missing:
        return {"error": f"Missing/invalid grades for '{subj.get('name')}': {', '.join(missing)}"}

    raw = (s1 * 0.30) + (s2 * 0.45) + (le * 0.25)
    wgp = math.ceil(raw)

    working = {
        "s1GP": s1, "s2GP": s2, "leGP": le,
        "rawWGP": round(raw, 4), "wgp": wgp
    }

    # Lab hybrid calculation (only for 4-credit courses with lab)
    if has_lab and credits == 4 and lab_marks is not None:
        lm = float(lab_marks)
        theory_pct = (wgp / 10) * 100 * 0.70
        lab_pct    = lm * 0.30
        final_pct  = theory_pct + lab_pct
        final_gp   = math.ceil(final_pct / 10)
        working.update({
            "hasLab": True, "labMarks": lm,
            "theoryPct": round(theory_pct, 2),
            "labPct":    round(lab_pct, 2),
            "finalPct":  round(final_pct, 2)
        })
    else:
        final_gp = wgp
        working["hasLab"] = False

    return {
        "finalGP": final_gp,
        "grade": GP_GRADE.get(final_gp, "—"),
        "working": working
    }

# ── routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("api\templates\index.html")


@app.route("/extract", methods=["POST"])
def extract():
    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400

    img   = request.files["image"]
    b64   = base64.b64encode(img.read()).decode("utf-8")
    mime  = img.mimetype or "image/png"

    prompt = """You are reading a GITAM University student portal results page screenshot.
It has TWO tables:
1. "Sessional Grades" — columns: Course Code, Course Title, Course Type, Category, then Sessional-I (Marks, Grade) and Sessional-II (Marks, Grade).
   Use the LATEST grade: if Sessional-II grade exists, use it as s2Grade. Use Sessional-I grade as s1Grade.
2. "Internal Marks" — columns: Course Code, Course Title, LE/CE.
   Rows with course codes ending in "P" are LAB rows — the LE/CE value is numeric lab marks.
   Non-P rows have a letter grade for LE/CE.

Rules:
- Merge the two tables by course code.
- Lab rows (code ends in P) are NOT separate subjects. Attach their numeric LE/CE value as labMarks to the parent subject (same code without P).
- If a subject has a corresponding lab row, set hasLab=true and labMarks=<numeric>.
- HSMCH102 and any subject with a pure numeric LE/CE grade — leave leGrade as that number string (e.g. "88"), the app will handle it.
- Skip ENVS1003.
- For credits: TP/PC = 4, HS types = 3, T/MS = 3, single credit = 1. Default 4 if unsure.

Return ONLY a JSON array, no markdown, no explanation, no backticks.
Each element:
{
  "name": "Subject Title",
  "courseCode": "19ECB332",
  "courseType": "TP",
  "credits": 4,
  "s1Grade": "O",
  "s2Grade": "B+",
  "leGrade": "O",
  "hasLab": true,
  "labMarks": 74
}"""

    try:
        resp = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"}},
                    {"type": "text", "text": prompt}
                ]
            }],
            max_tokens=2500
        )
        raw = resp.choices[0].message.content.strip()
        raw = raw.replace("```json", "").replace("```", "").strip()
        subjects = json.loads(raw)
        return jsonify({"subjects": subjects})
    except json.JSONDecodeError as e:
        return jsonify({"error": f"AI returned non-JSON: {str(e)}", "raw": raw[:500]}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/calculate", methods=["POST"])
def calculate():
    data           = request.json
    subjects       = data.get("subjects", [])
    current_cgpa   = float(data.get("currentCGPA")   or 0)
    current_credits= int(data.get("currentCredits")  or 0)

    results = []
    total_credits = 0
    total_cp      = 0
    errors        = []

    for s in subjects:
        res = compute_subject(s)
        if "error" in res:
            errors.append(res["error"])
            continue
        cr = int(s.get("credits", 4))
        total_credits += cr
        total_cp      += cr * res["finalGP"]
        results.append({
            "name":    s.get("name", "Unknown"),
            "credits": cr,
            "finalGP": res["finalGP"],
            "grade":   res["grade"],
            "working": res["working"]
        })

    if total_credits == 0:
        return jsonify({"error": "No valid subjects calculated. Check grade data."}), 400

    sgpa     = round(total_cp / total_credits, 2)
    new_cgpa = None
    if current_cgpa > 0 and current_credits > 0:
        new_cgpa = round(
            (current_cgpa * current_credits + total_cp) / (current_credits + total_credits), 2
        )

    return jsonify({
        "results":       results,
        "totalCredits":  total_credits,
        "totalCP":       total_cp,
        "sgpa":          sgpa,
        "newCGPA":       new_cgpa,
        "errors":        errors
    })


if __name__ == '__main__':
    app.run(debug=True)