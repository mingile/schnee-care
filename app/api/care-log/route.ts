import { NextResponse } from "next/server";

type CareType =
  | "체크인"
  | "귀청소"
  | "목욕"
  | "발털정리"
  | "발톱정리"
  | "빗질"
  | "세안" 
  | "양치";

type CareStatus = "완료" | "왼쪽" | "오른쪽";

type NotionQueryResponse = {
  results?: Array<{
    id?: string;
  }>;
};

type NotionCreatePageResponse = {
  id?: string;
  url?: string;
};

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2026-03-11";
const NOTION_CARE_LOG_DATA_SOURCE_ID = process.env.NOTION_CARE_LOG_DATA_SOURCE_ID;
const NOTION_CARE_TYPE_DATA_SOURCE_ID = process.env.NOTION_CARE_TYPE_DATA_SOURCE_ID;
const NOTION_CARE_TYPE_TITLE_PROP = process.env.NOTION_CARE_TYPE_TITLE_PROP || "종류";

const PROP_TITLE = "이름"; // 기본 title 속성명. Name이면 "Name"으로 바꾸세요.
const PROP_TYPE = "종류";
const PROP_DATE = "케어날짜";
const PROP_MEMO = "일일 특이사항";
const PROP_STATUS = "상태";

const CARE_TYPE_ALIASES: Record<CareType, string[]> = {
  체크인: ["체크인", "체크"],
  귀청소: ["귀청소", "귀 청소", "귀 닦기", "귀 닦았", "귀 털 정리"],
  목욕: ["목욕", "씻김", "씻겼", "샤워"],
  발털정리: ["발털정리", "발 털 정리", "발털", "발 털"],
  발톱정리: ["발톱정리", "발톱 정리", "발톱", "며느리발톱", "며느리 발톱"],
  빗질: ["빗질", "빗", "브러싱", "브러쉬"],
  세안: ["세안", "얼굴 닦기", "눈물자국", "눈물 자국"],
  양치: ["양치", "이 닦기", "치카", "칫솔"],
};

function normalizeText(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!?]/g, "");
}

function formatDateToKST(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(date); // YYYY-MM-DD
}

function addDays(base: Date, days: number): Date {
  const copied = new Date(base);
  copied.setDate(copied.getDate() + days);
  return copied;
}

function parseDate(text: string): { date: string; matchedPhrases: string[] } {
  const now = new Date();
  const matchedPhrases: string[] = [];

  // 절대 날짜 우선
  const isoMatch = text.match(/\b(20\d{2}-\d{1,2}-\d{1,2})\b/);
  if (isoMatch) {
    matchedPhrases.push(isoMatch[1]);
    const [y, m, d] = isoMatch[1].split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return { date: formatDateToKST(date), matchedPhrases };
  }

  const koreanDateMatch = text.match(/(20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (koreanDateMatch) {
    matchedPhrases.push(koreanDateMatch[0]);
    const y = Number(koreanDateMatch[1]);
    const m = Number(koreanDateMatch[2]);
    const d = Number(koreanDateMatch[3]);
    const date = new Date(y, m - 1, d);
    return { date: formatDateToKST(date), matchedPhrases };
  }

  if (text.includes("오늘")) {
    matchedPhrases.push("오늘");
    return { date: formatDateToKST(now), matchedPhrases };
  }

  if (text.includes("어제")) {
    matchedPhrases.push("어제");
    return { date: formatDateToKST(addDays(now, -1)), matchedPhrases };
  }

  if (text.includes("내일")) {
    matchedPhrases.push("내일");
    return { date: formatDateToKST(addDays(now, 1)), matchedPhrases };
  }

  // 아무 표현이 없으면 오늘로 처리
  return { date: formatDateToKST(now), matchedPhrases };
}

function parseCareType(text: string): { type: CareType | null; matchedPhrases: string[] } {
  for (const [type, aliases] of Object.entries(CARE_TYPE_ALIASES) as [CareType, string[]][]) {
    for (const alias of aliases) {
      if (text.includes(alias)) {
        return { type, matchedPhrases: [alias] };
      }
    }
  }

  return { type: null, matchedPhrases: [] };
}

function parseStatus(text: string): { status: CareStatus; matchedPhrases: string[] } {
  const leftKeywords = ["왼쪽", "왼"];
  const rightKeywords = ["오른쪽", "오른"];
  const doneKeywords = ["완료", "했어", "했음", "했다", "끝", "끝냄", "끝냈", "해줬", "해줌"];

  for (const keyword of leftKeywords) {
    if (text.includes(keyword)) {
      return { status: "왼쪽", matchedPhrases: [keyword] };
    }
  }

  for (const keyword of rightKeywords) {
    if (text.includes(keyword)) {
      return { status: "오른쪽", matchedPhrases: [keyword] };
    }
  }

  for (const keyword of doneKeywords) {
    if (text.includes(keyword)) {
      return { status: "완료", matchedPhrases: [keyword] };
    }
  }

  return { status: "완료", matchedPhrases: [] };
}

function buildMemo(text: string, phrasesToRemove: string[]): string {
  let memo = text;

  for (const phrase of phrasesToRemove) {
    if (!phrase) continue;
    memo = memo.replace(phrase, " ");
  }

  memo = memo
    .replace(/\s+/g, " ")
    .replace(/^(오늘|어제|내일)\s*/, "")
    .replace(/(했어|했음|했다|완료|실패|부분)$/g, "")
    .trim();

  return memo;
}

async function findCareTypePageId(type: CareType): Promise<string> {
  if (!NOTION_API_KEY || !NOTION_CARE_TYPE_DATA_SOURCE_ID) {
    throw new Error("Missing NOTION_API_KEY or NOTION_CARE_TYPE_DATA_SOURCE_ID");
  }

  const response = await fetch(
    `https://api.notion.com/v1/data_sources/${NOTION_CARE_TYPE_DATA_SOURCE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({
        filter: {
          property: NOTION_CARE_TYPE_TITLE_PROP,
          title: {
            equals: type,
          },
        },
        page_size: 1,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Notion Care Type Query Error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as NotionQueryResponse;
  const pageId = data?.results?.[0]?.id;

  if (!pageId) {
    throw new Error(`Care type page not found for: ${type}`);
  }

  return pageId;
}

async function createNotionPage(params: {
  type: CareType;
  date: string;
  status: CareStatus;
  memo: string;
  originalText: string;
}) {
  if (
    !NOTION_API_KEY ||
    !NOTION_CARE_LOG_DATA_SOURCE_ID ||
    !NOTION_CARE_TYPE_DATA_SOURCE_ID
  ) {
    throw new Error(
      "Missing NOTION_API_KEY, NOTION_CARE_LOG_DATA_SOURCE_ID, or NOTION_CARE_TYPE_DATA_SOURCE_ID"
    );
  }

  const { type, date, status, memo, originalText } = params;
  const careTypePageId = await findCareTypePageId(type);

  const title = `${type} ${date}`;

  const properties: Record<string, unknown> = {
    [PROP_TITLE]: {
      title: [
        {
          text: {
            content: title,
          },
        },
      ],
    },
    [PROP_TYPE]: {
      relation: [
        {
          id: careTypePageId,
        },
      ],
    },
    [PROP_DATE]: {
      date: {
        start: date,
      },
    },
    [PROP_STATUS]: {
      status: {
        name: status,
      },
    },
  };

  if (memo) {
    properties[PROP_MEMO] = {
      rich_text: [
        {
          text: {
            content: memo,
          },
        },
      ],
    };
  }

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      parent: {
        data_source_id: NOTION_CARE_LOG_DATA_SOURCE_ID,
      },
      properties,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: `원문: ${originalText}`,
                },
              },
            ],
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Notion API Error: ${response.status} ${errorText}`);
  }

  return (await response.json()) as NotionCreatePageResponse;
}

export async function GET() {
    return NextResponse.json({ ok: true, route: "care-log" });
  }

export async function POST(req: Request) {
  try {
    console.log("ENV CHECK:", {
      NOTION_API_KEY: NOTION_API_KEY ? "SET" : "MISSING",
      NOTION_CARE_LOG_DATA_SOURCE_ID,
      NOTION_CARE_TYPE_DATA_SOURCE_ID,
      NOTION_VERSION,
    });
    const body = await req.json();
    const rawText = typeof body?.text === "string" ? body.text : "";

    if (!rawText.trim()) {
      return NextResponse.json(
        { ok: false, error: "text is required" },
        { status: 400 }
      );
    }

    const text = normalizeText(rawText);

    const { date, matchedPhrases: dateMatches } = parseDate(text);
    const { type, matchedPhrases: typeMatches } = parseCareType(text);
    const { status, matchedPhrases: statusMatches } = parseStatus(text);

    if (!type) {
      return NextResponse.json(
        {
          ok: false,
          error: "케어 종류를 인식하지 못했습니다.",
          debug: {
            text,
          },
        },
        { status: 400 }
      );
    }

    const memo = buildMemo(text, [...dateMatches, ...typeMatches, ...statusMatches]);

    const notionPage = await createNotionPage({
      type,
      date,
      status,
      memo,
      originalText: rawText,
    });

    return NextResponse.json({
      ok: true,
      parsed: {
        type,
        date,
        status,
        memo,
      },
      notionPageId: notionPage.id ?? null,
      notionUrl: notionPage.url ?? null,
    });
  } catch (error) {
    console.error("[care-log][POST] error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}