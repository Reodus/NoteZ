// Assembly highlighting for ```asm/```nasm/```arm/```riscv/… fences. One
// tokenizer covers x86/x86-64 (Intel, NASM, MASM, AT&T/GAS), ARM/AArch64,
// RISC-V, MIPS and AVR. It follows the PDF grammar in
// core/src/render/asm.sublime-syntax, so both color the same tokens.
import { LanguageDescription, LanguageSupport, StreamLanguage, type StringStream } from "@codemirror/language";

/** Fence names (lower case) that select this language. */
/** MIPS fences: `$1` is register 1 there, an AT&T immediate elsewhere. */
export const MIPS_NAMES = ["mips", "mips64", "mipsasm"];
export const ASM_NAMES = [
  "asm", "nasm", "yasm", "fasm", "masm", "s", "gas", "att", "x86", "x64", "x86asm", "x86_64", "x86-64",
  "arm", "armasm", "arm64", "aarch64", "thumb", "riscv", "riscv32", "riscv64", "rv32", "rv64",
  "avr", "assembly",
];

const X86 = String.raw`(?:[re]?(?:ax|bx|cx|dx|si|di|sp|bp|ip)|[abcd][lh]|(?:si|di|sp|bp)l|r(?:[89]|1[0-5])[dwb]?|[xyz]mm(?:[12]?\d|3[01])|k[0-7]|mm[0-7]|st(?:\([0-7]\))?|[c-gs]s|cr\d{1,2}|dr[0-7]|[re]flags|tmm[0-7])`;
const ARM = String.raw`(?:r(?:1[0-5]|\d)|[xw](?:[12]?\d|3[01])|[xw]zr|w?sp|lr|pc|fp|ip|sb|sl|[bhsdqvz](?:[12]?\d|3[01])(?:\.\d*[bhsdq])?|p(?:1[0-5]|\d)|[ac]psr|spsr(?:_\w+)?|fpscr|fpsr|fpcr|nzcv)`;
const RV = String.raw`(?:zero|ra|gp|tp|t[0-6]|s(?:1[01]|\d)|a[0-7]|f[ast]?\d{1,2}|x(?:[12]?\d|3[01]))`;
const IDENT = String.raw`[A-Za-z_.$?@][\w.$?@]*`;

const re = (s: string, flags = "") => new RegExp(`^(?:${s})`, flags);
const R = {
  preproc: re(String.raw`#\s*(?:define|undef|include|if|ifdef|ifndef|elif|else|endif|error|warning|pragma|line)\b`),
  label: re(String.raw`(?:${IDENT}|\d+)(?=\s*:(?!:))`),
  namedDirective: re(String.raw`${IDENT}(?=\s+(?:proc|endp|segment|ends|macro|struc|struct|equ|label|record|typedef|textequ|d[bwdqtoyz]|res[bwdqtoyz])\b)`, "i"),
  dotDirective: re(String.raw`\.[A-Za-z_][\w.]*`),
  pctDirective: re(String.raw`%[A-Za-z_]\w*`),
  wordDirective: re(String.raw`(?:section|segment|global|globl|extern|extrn|bits|use16|use32|use64|default|align|alignb|org|cpu|struc|endstruc|istruc|iend|at|times|incbin|equ|public|end|include|includelib|assume|option|model|proc|endp|ends|invoke|d[bwdqtoyz]|res[bwdqtoyz]|macro|struct|label|record|typedef|textequ)\b`, "i"),
  prefix: re(String.raw`(?:lock|rep|repe|repz|repne|repnz|data16|data32|addr16|addr32|bnd|notrack|xacquire|xrelease)\b`, "i"),
  mnemonic: re(String.raw`[A-Za-z_][\w.]*`),
  sq: re(String.raw`'(?:[^'\\]|\\.)*'`),
  bq: re(String.raw`\x60(?:[^\x60\\]|\\.)*\x60`),
  reloc: re(String.raw`%(?:hi|lo|pcrel_hi|pcrel_lo|got_pcrel_hi|tprel_hi|tprel_lo|tprel_add|tls_ie_pcrel_hi|tls_gd_pcrel_hi|gp_rel|got|call16|call_hi|call_lo|higher|highest)\b|#?:[a-z_]\w*:`, "i"),
  at: re(String.raw`@(?:plt|gotpcrel|gotoff|got|gotntpoff|tpoff|ntpoff|dtpoff|tlsgd|tlsld|function|object|progbits|nobits|note|init_array|fini_array|ha|h|l|page|pageoff|gotpage|gotpageoff|tlvppage|tlvppageoff)\b`, "i"),
  mipsReg: re(String.raw`\$(?:zero|at|v[01]|a[0-7]|t\d|s[0-8]|k[01]|gp|sp|fp|ra|f\d{1,2})\b`),
  mipsNumReg: re(String.raw`\$f?\d{1,2}\b`),
  reg: re(String.raw`%?(?:${X86}|${ARM}|${RV})\b`, "i"),
  avrReg: re(String.raw`(?:r(?:[12]?\d|3[01])|[XYZ])\b`),
  size: re(String.raw`(?:byte|word|dword|qword|tword|oword|yword|zword|xmmword|ymmword|zmmword|tbyte|fword|real4|real8|real10|ptr|short|near|far|rel|abs|offset|seg|wrt|strict|dup|lsl|lsr|asr|ror|rrx|uxt[bhwx]|sxt[bhwx]|mul vl)\b`, "i"),
  localRef: re(String.raw`\d[bf]\b`),
  number: re(String.raw`[#$]?-?(?:0x[0-9a-f_]+|0b[01_]+|0o[0-7_]+|0q[0-7_]+|[0-9][0-9a-f_]*h|[01][01_]*[by]|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b`, "i"),
  word: /^[\w.$?]+/,
};

type State = { at: "start" | "ops"; block: boolean };

/** True when the character before the stream position is a word character. */
const afterWord = (s: StringStream) => s.pos > 0 && /[\w.$?@]/.test(s.string[s.pos - 1]);

function comment(s: StringStream, state: State): string | null {
  if (state.block || s.match("/*")) {
    state.block = true;
    while (!s.eol()) {
      if (s.match("*/")) {
        state.block = false;
        break;
      }
      s.next();
    }
    return "comment";
  }
  if (s.match(";") || s.match("//")) return (s.skipToEnd(), "comment");
  const c = s.peek();
  if ((c === "@" || c === "#") && (s.pos === 0 || /\s/.test(s.string[s.pos - 1]))) {
    const n = s.string[s.pos + 1];
    if (n === undefined || /\s/.test(n)) return (s.skipToEnd(), "comment");
  }
  return null;
}

/** The tokenizer; `mips` makes `$1` a register (see MIPS_NAMES). */
export const asmParser = (mips: boolean) => ({
  name: mips ? "mips" : "assembly",
  startState: (): State => ({ at: "start", block: false }),
  copyState: (s: State): State => ({ ...s }),
  token(s: StringStream, state: State): string | null {
    if (s.sol() && !state.block) state.at = "start";
    if (s.eatSpace()) return null;
    const c = comment(s, state);
    if (c) return c;
    if (state.at === "start") {
      if (s.match(R.preproc)) return (state.at = "ops", "variableName.function");
      if (s.peek() === "#") return (s.skipToEnd(), "comment");
      if (s.match(R.label)) {
        s.eatSpace();
        s.eat(":");
        return "labelName";
      }
      if (s.match(R.namedDirective)) return "labelName"; // the directive follows
      if (s.match(R.dotDirective) || s.match(R.pctDirective) || s.match(R.wordDirective))
        return (state.at = "ops", "variableName.function");
      if (s.match(R.prefix)) return "keyword";
      if (s.match(R.mnemonic)) return (state.at = "ops", "keyword");
      state.at = "ops";
      s.next();
      return null;
    }
    // operands
    if (s.peek() === '"') {
      s.next();
      while (!s.eol()) {
        const ch = s.next();
        if (ch === "\\") s.next();
        else if (ch === '"') break;
      }
      return "string";
    }
    if (s.match(R.sq) || s.match(R.bq)) return "string";
    if (s.match(R.reloc) || s.match(R.at)) return "variableName.function";
    if (s.match(R.mipsReg) || (mips && s.match(R.mipsNumReg))) return "typeName";
    if (!afterWord(s)) {
      if (s.match(R.reg) || s.match(R.avrReg)) return "typeName";
      if (s.match(R.size)) return "modifier";
      if (s.match(R.localRef)) return "labelName";
      if (s.match(R.number)) return "number";
      if (s.match(R.word)) return null;
    }
    if ((s.peek() === "#" || s.peek() === "$") && /[A-Za-z_.]/.test(s.string[s.pos + 1] ?? "")) {
      s.next();
      return "number";
    }
    s.next();
    return null;
  },
  languageData: { commentTokens: { line: mips ? "#" : ";", block: { open: "/*", close: "*/" } } },
});

const asmDescription = LanguageDescription.of({ name: "Assembly", alias: ASM_NAMES, support: new LanguageSupport(StreamLanguage.define(asmParser(false))) });
const mipsDescription = LanguageDescription.of({ name: "Assembly (MIPS)", alias: MIPS_NAMES, support: new LanguageSupport(StreamLanguage.define(asmParser(true))) });

/** Code-block language lookup: assembly first, then the bundled languages. */
export function codeLanguage(languages: readonly LanguageDescription[]) {
  return (info: string) => {
    const name = info.trim().split(/\s/)[0].toLowerCase();
    if (MIPS_NAMES.includes(name)) return mipsDescription;
    return ASM_NAMES.includes(name) ? asmDescription : LanguageDescription.matchLanguageName(languages, info, true);
  };
}
