// Block Town templates as the Studio lists them (the same ids, names and lengths as the worker's
// kage-motion/worker/blocky-templates.ts, which holds the beats the writer follows). A person picks one and gives
// their twist; the job carries options.story.template. Docs: docs/story-styles/PLAN.md, REFERENCE_JEXARIO.md.
export type StoryTemplate = { id: string; name: string; pitch: string; hook: string; example: string; seconds: number; ending: "cliffhanger" | "payoff" | "twist" };
export const STORY_TEMPLATES: StoryTemplate[] = [
  { id: "one-rule", name: "The One Rule", pitch: "A town with one rule nobody may break, and the day someone breaks it.", hook: "In this town, you must never [do X].", example: "In this town, you must never look up at the night sky", seconds: 120, ending: "cliffhanger" },
  { id: "never-seen", name: "The World Without", pitch: "A town that has never seen something, until one kid finds it and it spreads.", hook: "In this town, nobody has ever seen [X].", example: "In this town, nobody has ever heard music", seconds: 120, ending: "payoff" },
  { id: "except-me", name: "Everyone Except Me", pitch: "Everyone in town has something special, except the narrator.", hook: "In this town, everyone has a [thing]. Except me.", example: "In this town, everyone has a pet dragon. Except me", seconds: 120, ending: "twist" },
  { id: "strange-ability", name: "The Strange Ability", pitch: "Everyone in town can do one strange thing, and it changes everything.", hook: "In this town, everyone can [ability].", example: "In this town, everyone floats when they are happy", seconds: 120, ending: "cliffhanger" },
  { id: "daily-change", name: "The Daily Change", pitch: "Every night the town changes one thing, and one morning it changes the wrong thing.", hook: "In this town, every night [something changes].", example: "In this town, every night the houses swap places", seconds: 90, ending: "cliffhanger" },
  { id: "number-decides", name: "The Number That Decides", pitch: "A silly number decides your whole life in this town.", hook: "In this town, your [number] decides your life.", example: "In this town, your shoe size decides your job", seconds: 90, ending: "twist" },
];
export const storyTemplate = (id: unknown): StoryTemplate | null => STORY_TEMPLATES.find((t) => t.id === id) ?? null;
