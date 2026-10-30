# Short-form video performance playbook: sourced evidence base (compiled Oct 30, 2026)

Purpose: the evidence layer for the Clone8 Studio AI performance coach. Every finding has a claim, platform, source (who, sample size, date), URL and a confidence note. The findings fall into three tiers:

- **(A) Platform-confirmed**: the platform itself, its executives on the record, or its transparency documents.
- **(B) Large-study benchmarks**: third-party datasets with a stated sample size. These are vendor studies, mostly correlational, and mostly from *brand* accounts.
- **(C) Practitioner consensus**: widely repeated, weakly evidenced. **The coach should present these as heuristics, not facts.**

Confidence key: **High** = primary source read directly. **Med** = primary source, but read through reliable trade press (Social Media Today, TechCrunch, SEJ, Tubefilter), or a vendor study with a clear method. **Low** = a single secondary source, an unclear method, or a source that contradicts itself.

Read these caveats before using any number:

1. **"Engagement rate" means different things.** It can be divided by followers (Socialinsider, Rival IQ), by reach (Buffer), or by views (Dash Social, Socialinsider's TikTok length study). The resulting figures differ by about 10x. Never compare across denominators.
2. **Vendor samples are mostly brand accounts with 1K–1M followers.** Creator accounts usually run higher engagement.
3. **Several Socialinsider pages contradict themselves** on sample totals, tier bounds and some percentages (details in §B). Their numbers are usable as orders of magnitude, not as precise thresholds.
4. **View definitions changed.** YouTube Shorts views count every start or replay from Mar 31, 2025. Instagram moved to "views" as its primary metric in Aug 2024. Cross-platform view comparisons are apples-to-oranges.

---

## (A) Platform-confirmed signals

### Instagram / Meta

**A1. The top three ranking signals are watch time, likes and sends, each measured per reach.**
- Mosseri: "The top three signals that matter most for ranking are watch time, likes and sends." He told creators to "pay close attention to average watch time, likes per reach, and sends per reach."
- Mosseri: "Likes are slightly more important for connected content, and sends are slightly more important for unconnected content." Connected means followers; unconnected means non-followers, i.e. growth.
- Source: Mosseri's ranking video series, Jan 22, 2025, via Social Media Today. https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/
- Confidence: **High** (direct quotes).
- Note: comments were *not* on his list. The popular claim that sends weigh "3–5x" likes is **unsupported**; his wording was "slightly more important." Fact-check: https://keywordseverywhere.com/news/instagram-algorithm-updates/

**A2. Meta's Instagram Reels system card lists the actual predictions the ranker makes.** Updated Nov 11, 2025.
- Predictions:
  - P(watch **less than 3 seconds**)
  - P(watch **more of a reel than 95% of users who watched reels of the same length**)
  - P(reshare)
  - P(**share off Instagram**)
  - P(comment)
  - P(**follow the author**)
  - P(use the reel's **audio** in your own reel)
  - P(tap "Interested")
  - P(open a tall reel from Explore)
- Inputs include: how often the reel was skipped within 2 s of opening, how often it was viewed with sound on, the number of followers the author gained *through that reel*, and how often the post was shared externally.
- Source: Meta Transparency Center, Reels Chaining AI system card. https://transparency.meta.com/features/explaining-ranking/ig-reels-chaining/
- Confidence: **High**.
- Coach implication: watch time is judged **relative to reels of the same length** (a length-normalised percentile), not in raw seconds. Early skips, follows and off-platform shares are explicit targets.

**A3. Identical reposts are swapped for the original, and aggregators lose recommendations.** Announced Apr 30, 2024.
- When Instagram finds two or more identical pieces of content, it recommends only the original. The original replaces the repost in Explore, Reels and in-feed suggestions.
- Content that is "significantly changed" (for example a meme or parody edit) is not replaced.
- Accounts that repeatedly post content they didn't create or enhance are removed from recommendations. Followers still see their posts.
- The same update added a ranking input that gives small creators staged exposure: a small predicted audience first, then progressively wider audiences for top performers.
- Source: TechCrunch, Apr 30, 2024. https://techcrunch.com/2024/04/30/instagram-is-updating-its-ranking-systems-to-surface-more-content-from-smaller-original-creators
- Confidence: **High**.
- The widely quoted ">10 reposts in 30 days" threshold is **not** in Instagram's announcement. Treat it as unverified.

**A4. The originality penalty was extended to photos and carousels.** Apr 30, 2026.
- Accounts that repost too much become ineligible for recommendations.
- Changing a video's speed, or adding a screenshot of the original poster's name, is **not** enough enhancement.
- Examples of real enhancement: unique text, creative edits, voiceover, commentary, humour.
- Source: Instagram Creators blog via Tubefilter. https://www.tubefilter.com/2026/04/30/instagram-removes-algorithm-recommendations-repost-content-aggregator/
- Confidence: **High** on the rule. **Low** on the recovery rule: "eligible again when most posts in a rolling 30 days are original" comes from secondary sources only.

**A5. Instagram's Recommendation Guidelines say what gets less reach with non-followers.**
- Avoid reels that are reposts or already on Instagram, unoriginal or aggregated, watermarked, or blurry or low quality.
- To be recommended, reels should be high-resolution 9:16, with no borders, and text should not cover most of the screen.
- Reels must be **3 minutes or less** to be recommended.
- Repeated violations can make the **entire account** ineligible for recommendation for a period of time.
- Source: Instagram Creators blog, Aug 30, 2022, updated Apr 25, 2023. https://creators.instagram.com/blog/instagram-recommendations-eligibility-tips-creators
- Confidence: **High**. The 3-minute rule is consistent with the Jan 2025 length change (A8).

**A6. Your own logo is fine; other apps' watermarks are not.**
- Mosseri: Instagram tries "not [to] recommend Reels with logos from other apps, but if it's your own logo, don't worry about it."
- Editing in third-party apps such as CapCut is not penalised.
- The TikTok-watermark demotion dates from Feb 2021.
- Sources: Social Media Today https://www.socialmediatoday.com/news/instagram-clarifies-that-including-your-own-logo-on-a-reel-is-ok/730852/ ; Tubefilter 2021 https://tubefilter.com/2021/02/10/instagram-reels-with-tiktok-watermark-less-discoverable/
- Confidence: **High** on the rule. **Med** on the exact quote.

**A7. Originality is now measured at scale.** From Meta earnings calls.
- Q4 2025 call (Jan 28, 2026), Susan Li: Meta "grew the prevalence of original content in the US by 10 percentage points in Q4," with "75% of recommendations now coming from original posts." This was up from more than 60% on the Q3 2024 call.
- Q3 2026 call (Oct 21, 2026):
  - "On Instagram Reels, our relevance launches in Q3 increased Reels time spent by over 4%." This came partly from a model that ranks sequences of Reels and from "richer watch time signals."
  - "Nearly 45% of recommended Instagram Reels are now less than one day old."
- Sources: https://www.fool.com/earnings/call-transcripts/2026/01/28/meta-meta-q4-2025-earnings-call-transcript/ ; https://stockanalysis.com/stocks/meta/transcripts/718643-q3-2026/
- Confidence: **High**.
- Coach implication: freshness matters. A Reel's recommendation window is short, so judge a post on its first-days performance.

**A8. Reels can be up to 3 minutes, but Instagram is still "focused on short form."** Jan 19, 2025.
- Mosseri: "We still are focused on short form video over long form."
- Source: Social Media Today. https://www.socialmediatoday.com/news/instagram-officially-expands-reels-length-to-3-minutes/737766/
- Confidence: **High**.
- The old "Reels over 90 s get hurt" advice is **outdated**.

**A9. Skip rate and the retention chart are now in Reels Insights.** Aug 24, 2025.
- Skip rate is "the percentage of views from people who decided to skip your reel during those first 3 seconds." It replaced View Rate.
- On retention, Instagram says: "you'll always see a downward slope, but the flatter the line, the more engaged your audience is."
- Source: Social Media Today. https://www.socialmediatoday.com/news/instagram-adds-retention-insights-reels/758464/
- Confidence: **High**.
- Instagram publishes **no** "healthy skip rate." Blog claims such as "30–40% is healthy" or "skip rate is the #1 factor" are **unsupported**; see B11 for real medians.
- An April 2026 Insights redesign reportedly added a per-post **share rate** (Inrō, secondary, **Med-Low**). https://www.inro.social/blog/instagram-insights-update

**A10. Trial Reels: test with non-followers first.**
- Launched Dec 10, 2024; expanded in 2025.
- Mosseri says trials almost always get less reach because they lack follower engagement. **Compare trial against trial**, not trial against regular posts.
- Sources: https://www.socialmediatoday.com/news/instagram-expands-access-trial-reels/752895/ ; Buffer https://buffer.com/resources/instagram-trial-reels/
- Confidence: **Med**. The figures "80% of creators see more non-follower reach" are secondary only and unverified.

**A11. Hashtags are not a reach lever, and are capped at 5.**
- Mosseri has repeatedly said hashtags don't meaningfully increase distribution: 2022, then again in 2024.
- Instagram capped hashtags at 5 per post (Dec 18, 2025, via @creators).
- Sources: Hootsuite https://blog.hootsuite.com/social-media-updates/instagram/hashtags-dont-affect-reach/ ; tracker https://keywordseverywhere.com/news/instagram-algorithm-updates/
- Confidence: **Med-High**.

**A12. Unlabelled AI personas lose recommendation eligibility.** Announced Aug 31, 2026.
- Profiles built around an AI-generated person without the "AI-generated profile" label become ineligible for Reels and Explore recommendations. Followers still see them.
- Human creators who use AI tools are not targeted.
- Adding the label restores eligibility. Creators can check and appeal in Account Status.
- Sources: NetInfluencer https://www.netinfluencer.com/instagram-to-limit-the-reach-of-unlabeled-ai-generated-profiles/ ; Implicator https://www.implicator.ai/instagram-will-cut-the-reach-of-ai-personas-that-skip-its-new-label/
- Confidence: **Med** (trade press; start date of enforcement unclear).
- Directly relevant to Clone8 avatar or synthetic-host output.

**A13. Users can now edit their own interest profile ("Your Algorithm").**
- Launched on Reels Dec 10, 2025; extended to Explore (Apr 2026) and Feed (Jun 2026).
- Users edit inferred interest topics.
- Source: tracker citing the Instagram blog and TechCrunch. https://keywordseverywhere.com/news/instagram-algorithm-updates/
- Confidence: **Med**.
- Inference, not confirmed: content with a clear, consistent topic is easier to map to a user's chosen interests.

**A14. Meta (Facebook) defines unoriginal content and lists low-value edits.**
- Unoriginal includes: "stitching multiple clips together… without adding anything meaningful," "narrating what's already on screen," and re-uploads with "low-value changes such as adding borders, inserting captions, or changing speed."
- Accounts posting mainly unoriginal content "may see their account deemed non-recommendable and demonetized."
- Meta also reported that views and watch time of *original* Reels roughly doubled in H2 2025 versus H2 2024.
- Source: Meta Newsroom, Mar 2026. https://about.fb.com/news/2026/03/rewarding-original-creators-on-facebook/
- Confidence: **High**.
- **This is the single most important rule for a product that makes "originals" from one source video.** Captions, borders and speed changes alone are explicitly *not* original.

**A15. Facebook's July 2025 creator guidance is written as a list of best practices.**
- Original content gets the most distribution. "You can share the same content across your own Pages or profiles."
- "Simply stitching together clips or adding your watermark" is not a meaningful enhancement.
- Avoid third-party watermarks.
- "Tell a story": avoid very short videos that give little value.
- Captions perform best with no links, minimal capitalisation and ≤5 hashtags.
- Duplicate videos get reduced distribution.
- Repeat offenders lose monetisation and distribution on everything they post.
- Source: Facebook Creators blog, Jul 14, 2025. https://creators.facebook.com/blog/combating-unoriginal-content
- Confidence: **High**.

**A16. Facebook Reels ranking optimises video engagement and blends in friend signals.**
- The "friend bubbles" objective is added to a video-ranking formula built on watch time, comments and likes.
- Expressive reactions (love, laughter) drive more downstream engagement than plain likes.
- Doubling the history the Facebook Reels ranking model considers gave +1% Reels watch time in the US (Q3 2026 call).
- Source: Meta Engineering, Mar 18, 2026. https://engineering.fb.com/2026/03/18/ml-applications/friend-bubbles-enhancing-social-discovery-on-facebook-reels/
- Confidence: **High**.

### TikTok

**A17. TikTok's official recommendation factors.**
- User interactions: likes, shares, comments, follows, content you create.
- Video information: captions, sounds, hashtags.
- Device and account settings carry lower weight.
- Strong signal: "whether a user finishes watching a longer video from beginning to end."
- Weak signal: viewer and creator being in the same country.
- "Neither follower count nor whether the account has had previous high-performing videos are direct factors."
- The feed avoids back-to-back videos with the same sound or creator. TikTok doesn't recommend duplicated content, already-seen content or spam.
- Source: TikTok Newsroom, "How TikTok recommends videos #ForYou." https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you/
- Confidence: **High**, but the document dates from 2020 with a 2023 refresh.

**A18. Leaked "TikTok Algo 101" (NYT, Dec 2021).**
- Simplified scoring: Plike·Vlike + Pcomment·Vcomment + Eplaytime·Vplaytime + Pplay·Vplay.
- Optimisation goals: **retention and time spent**.
- Source: Gizmodo summary of the NYT report. https://gizmodo.com/leaked-tiktok-doc-reveals-its-obvious-secret-to-an-addi-1848166901
- Confidence: **Med** (authenticity confirmed by TikTok at the time).
- **Dated (2021).** Directionally consistent with A17, but use it only for the shape of the model, not for weights.

**A19. Creator Rewards Program favours originality and videos over 1 minute.**
- Pays per 1,000 *qualified* For You views on **original videos over 1 minute**.
- Scoring criteria: **originality, play duration, audience engagement, search value**.
- Source: TikTok Newsroom, Mar 18, 2024. https://newsroom.tiktok.com/introducing-the-new-creator-rewards-program
- Confidence: **High** on the criteria. Payout figures (often quoted as $0.40–1.50 RPM) are **Low**.
- This incentive confounds length studies: creators deliberately stretch to more than 60 s.

**A20. TikTok's originality policy.**
- Unoriginal content can be made ineligible for the For You feed and for monetisation.
- It covers: copied content, lightly repurposed material, compilations with little added value, and other creators' watermarks or logos.
- The video stays on the profile but stops being recommended.
- Source: TikTok Creator Academy, "TikTok originality policy." https://www.tiktok.com/creator-academy/article/tiktok-originality-policy
- Confidence: **Med**. The page did not render for direct reading; the details come from consistent third-party summaries.
- A secondary claim that reposting your *own* old video doesn't count as fresh is **Low**.

**A21. TikTok's ad creative guidance on hooks, which also applies to organic video.**
- "Over 63% of all videos with the highest click-through rate (CTR) highlight their key message or product within the first 3 seconds."
- On-screen text: show 5–10 words per second.
- Source: TikTok Auction Ads creative tips, https://ads.tiktok.com/business/library/Auction_Ads_Creative_Tips.pdf ; Ads Help Center https://ads.tiktok.com/help/article/creative-best-practices
- Confidence: **Med**. This is TikTok's own data, but no sample or method is given, and it describes winners rather than proving cause. Ads, not organic. TikTok's own pages alternate between "first 3 s" and "hook in the first 6 s."

**A22. Users can tune AI content in their feed.**
- A "Manage Topics" slider lets users see more or less AI-generated content (Nov 2025).
- Realistic AI content must be labelled; TikTok uses C2PA Content Credentials.
- Source: TechCrunch, Nov 18, 2025. https://techcrunch.com/2025/11/18/tiktok-now-lets-you-choose-how-much-ai-generated-content-you-want-to-see/
- Confidence: **High**.

**A23. The US recommendation model is being retrained.**
- Since Jan 2026, TikTok USDS Joint Venture licenses ByteDance's algorithm and retrains it on US user data.
- Source: Al Jazeera, Jan 23, 2026. https://www.aljazeera.com/news/2026/1/23/who-controls-tiktoks-us-platform-under-new-deal
- Confidence: **Med**.
- Claims of US creators seeing "20–40% reach drops" are **unverified**. Expect US benchmarks from before 2026 to drift.

### YouTube Shorts

**A24. Shorts can be up to 3 minutes,** for uploads from Oct 15, 2024.
- Most music can run up to 90 s inside a 3-minute Short.
- **Shorts longer than 1 minute with an active Content ID claim are blocked.**
- Source: YouTube Help, "Understand three-minute YouTube Shorts." https://support.google.com/youtube/answer/15424877
- Confidence: **High**.
- The music/Content ID constraint matters for any product that adds licensed audio to a Short over 60 s.

**A25. The Shorts view count changed on Mar 31, 2025.**
- A view now counts on every start or replay, with no minimum watch time.
- The old metric survives as **"engaged views"** (Advanced Mode). YouTube Partner Program eligibility and revenue use engaged views.
- Sources: TechCrunch https://techcrunch.com/2025/03/26/youtube-is-changing-how-youtube-shorts-views-are-counted ; SEJ https://www.searchenginejournal.com/youtube-changes-shorts-view-counts-no-change-to-monetization/543005/
- Confidence: **High**.
- Implication: engaged views ÷ views is now a usable hook-quality ratio.

**A26. "Viewed vs. swiped away" is YouTube's own Shorts hook metric.**
- Shown in YouTube Studio, Analytics → Content → Shorts. The two shares sum to about 100%.
- Todd Sherman (Shorts product, Creator Insider, 2023): "What we try to do in recommendations is independent of duration, to figure out if someone really enjoyed the video." He also described a staged "test small audience → expand" process.
- Sources: Creator Handbook https://www.creatorhandbook.net/youtube-explains-how-the-youtube-shorts-algorithm-works/ ; glossary https://www.creatoressentials.com/glossary/viewed-vs-swiped-away/
- Confidence: **Med** (primary video read via secondary sources).
- YouTube publishes **no** benchmark. The "70–80% viewed" target is practitioner lore (C).

**A27. Recommendations now favour original Shorts.** Oct 1, 2026.
- Rene Ritchie (Creator Liaison): remixers must add value, "not just VO descriptions of what's happening on screen, minor technical edits, or template-based bulk changes."
- On recovery: "If your channel was previously aggregating or re-uploading and you shift towards original content, the recommendation system will re-evaluate reach."
- No timeline was given. Shorts cut from a creator's *own* long-form videos were not addressed.
- Sources: Creator Insider video https://www.youtube.com/watch?v=XS2A6aExLaA via SEJ https://www.searchenginejournal.com/youtube-original-shorts-reposted-clips-reach/591774/
- Confidence: **High**.
- **"Template-based bulk changes" describes exactly the risk of naive variant generation.**

**A28. "Repetitious content" was renamed "inauthentic content."** YouTube Partner Program, Jul 15, 2025.
- It covers mass-produced or repetitive content: near-identical narrated stories, templated videos with slight variations, slideshows with no real narration.
- Ritchie called it a minor clarification. Reaction and commentary channels are not targeted.
- Sources: SEJ https://www.searchenginejournal.com/youtube-clarifies-monetization-update-targeting-spam-not-reaction-channels/550755/ ; PPC Land https://ppc.land/youtube-clarifies-inauthentic-content-policy-changes/
- Confidence: **High**.

**A29. Shorts dropped the dislike button.** June 2026.
- Feedback now goes through "Not interested" (with reasons) and "Don't recommend channel."
- YouTube's reasoning: a dislike was an ambiguous signal.
- Source: Tubefilter, Jun 26, 2026. https://www.tubefilter.com/2026/06/26/youtube-shorts-new-layout-features-no-distractions-dislikes/
- Confidence: **High**.
- Implication: negative feedback is now mostly silent swipes plus "Not interested." Swipe-away rate carries more of the negative signal.

**A30. Scale.**
- Shorts average **200B+ daily views** (Neal Mohan, Cannes Lions, June 2025), up from 70B in Mar 2024.
- Source: Tubefilter. https://www.tubefilter.com/2025/06/18/youtube-shorts-200-billion-daily-views-google-veo-3-ai-neal-mohan/
- Confidence: **High**. These are inflated by the post-March-2025 counting change.

### LinkedIn and Threads (brief)

**A31. LinkedIn video.**
- Video uploads rose 34–36% YoY (FY Q4 2024, Microsoft earnings).
- A dedicated vertical video feed was tested from Mar 2024 and came to web in Feb 2025.
- Source: TechCrunch, Feb 4, 2025. https://techcrunch.com/2025/02/04/linkedin-amps-up-vertical-video-tools-as-uploads-jump-36
- Confidence: **Med**. LinkedIn has disclosed **no** video ranking signals that I could find.

**A32. Threads.**
- Meta's explainer: the ranking system predicts "value" to the user. Inputs include reply-click behaviour.
- Threads time spent: +20% from ranking work (Q4 2025 call); per-user time spent +20% (Q3 2026 call).
- Mosseri's "replies are as valuable as posts" is **secondary only**.
- Sources: https://buffer.com/resources/threads-algorithm/ ; Q4 2025 call above.
- Confidence: **Med-Low** for creator-actionable signals.

---

## (B) Large-study benchmarks with numbers

### Engagement and views by platform and tier

**B1. Engagement rate by followers.** Socialinsider TikTok vs Reels vs Shorts study.
- Sample: 35.6M TikToks, 36.7M Reels, 7.5M Shorts from brands with 1K–1M followers, Jan 2025 – Jun 2026. Published Aug 5, 2026.

| Platform | 2025 | 2026 |
|---|---|---|
| TikTok | 3.70% | 2.60% |
| Instagram Reels | 0.48% | 0.45% |
| YouTube Shorts | 0.27% | 0.30% |

- Average comments per video: TikTok 50, Reels 20, Shorts 10.
- Formula: TikTok uses likes + comments + shares; Reels and Shorts use likes + comments only.
- Source: https://www.socialinsider.io/blog/tiktok-vs-reels-vs-shorts/
- Confidence: **Med**. The tier sums don't match the stated totals.

**B2. Average views per video by follower tier.** Same study as B1.

| Tier | TikTok | Reels | Shorts |
|---|---|---|---|
| <5K | 350 | 625 | 15,160 |
| 5–10K | 945 | 1,182 | 22,000 |
| 10–50K | 3,240 | 2,745 | 23,200 |
| 50–100K | 9,900 | 6,000 | 28,400 |
| 100K–1M | 34,900 | 18,300 | 58,400 |

- Note: Shorts are high for small accounts, which is consistent with liberal start-based view counting.
- Confidence: **Med**.

**B3. Cross-platform averages, 2025.** Socialinsider benchmark (stated ~198M posts).

| Metric | TikTok | Instagram | Facebook |
|---|---|---|---|
| Engagement rate by followers | 3.70% | 0.48% | 0.15% |
| Avg shares per post | 248 | 45 | 17 |
| Avg views per post | 6,496 | 3,403 | 913 |

- Year-on-year shares: TikTok +46%, Instagram +13%.
- Source: https://www.socialinsider.io/social-media-benchmarks
- Confidence: **Med-Low**. These are averages, skewed by outliers, and the page has internal inconsistencies.

**B4. Median engagement by reach/impressions.** Buffer, page published Jan 7, 2026.

| Platform | Median engagement rate | Sample |
|---|---|---|
| LinkedIn | 6.5% | not stated |
| TikTok | 4.86% | not stated |
| Instagram | 4.3% | 27M posts, 273K accounts |
| Facebook | 3.6% | 52M posts, 213K accounts |

- Instagram by tier: about 5% under 1K followers; about 3.7% at 10–50K.
- Source: https://buffer.com/resources/social-media-benchmarks/
- Confidence: **Med**. Buffer users skew small and creator-heavy, so these are closer to creator reality than brand panels.

**B5. Engagement by views.** Dash Social, all industries, 2026 edition.
- TikTok 3.9–4.2%; Instagram 2.6%.
- Average reach per post about 78K on both (big brands).
- Reels average **711 shares per post**, 27% above Instagram's average.
- Source: https://www.dashsocial.com/social-media-benchmarks/all-industries
- Confidence: **Med**. Big-brand panel; sample not stated.

**B6. Reels by industry.** Dash Social: 3.3K brands, Jul–Dec 2025.
- All-industry averages: 283K views, 182K reach, 1.3K shares, 618 saves.
- Derived (my calculation): about **0.7% shares/reach** and about **0.34% saves/reach**.
- Engagement rate ranges 0.1–0.5% by industry: Media & Entertainment and Travel 0.5%; Fashion and Home 0.1%.
- Source: https://www.dashsocial.com/blog/instagram-reels-performance-benchmarks
- Confidence: **Med**. The derived ratios are ratios of means, so treat them as rough.

**B7. Median engagement by followers.** Rival IQ, 2025 edition (150 companies per industry).
- TikTok about 1.73%; Instagram about 0.36%.
- The 2026 edition is reported (secondary) at TikTok about 2.01% and Instagram about 0.30%.
- Source: https://get.rivaliq.com/hubfs/eBooks/2025-Social-Media-Industry-Benchmark-Report.pdf
- Confidence: **Low-Med**. Not read directly.

**B8. Nano-creator engagement.** HypeAuditor State of Influencer Marketing 2025 (76M IG, 104M TikTok, 13.1M YouTube accounts; 2024 data).
- Instagram nano (1–10K) about **2.19%**, the highest tier.
- TikTok nano **10.3% or 11.9%**; the page states both.
- Source: https://hypeauditor.com/state-of-influencer-marketing-2025/
- Confidence: **Med-Low**. Self-contradictory, with a mixed views/followers denominator.

### Reach, skip rate and retention (Instagram)

**B9. Reels reach rate (reach ÷ followers) by tier.** Socialinsider Reels statistics: 9.77M Reels, Jan–Jun 2026.

| Tier | Reels | Carousels | Images |
|---|---|---|---|
| 1–5K | 9.78% | 8.80% | 7.00% |
| 5–10K | 7.55% | 7.40% | 6.35% |
| 10–50K | 7.10% | 6.40% | 5.50% |
| 50–100K | 5.60% | 5.85% | 4.70% |
| 100K–1M | 5.00% | 6.00% | 5.00% |

- Above 50K followers, carousels match or beat Reels on reach rate.
- Source: https://www.socialinsider.io/blog/instagram-reels-statistics/
- Confidence: **Med**.

**B10. Reels reach rate by length.** Same Socialinsider study as B9.

| Length | Reach rate |
|---|---|
| <30 s | 5.2% |
| 30–60 s | **5.6%** (highest) |
| 60–90 s | 5.3% |
| 90–120 s | 4.3% |
| >120 s | 3.5% |

- Confidence: **Med**.

**B11. Real-world Reels skip rate is about 60–65%.**
- Skip rate is the share of plays skipped within the first 3 s.

| Tier | Skip rate |
|---|---|
| 1–5K | 65.5% |
| 5–10K | 65.3% |
| 10–50K | 63.4% |
| 50–100K | 62.6% |
| 100K–1M | 60.5% |

- Same source as B9.
- Confidence: **Med**.
- **This contradicts the blog lore that "above 50% means your Reel is low quality."** The typical brand Reel loses about 63% of plays in 3 s. The coach should benchmark skip rate against the creator's *own* median, then against this table.

**B12. Instagram changes, Jan–Feb 2026 vs Jan–Feb 2025.** Metricool: 24.36M posts, 375K accounts. Published Jun 16, 2026.
- Average Reels watch time more than doubled, to **8.5 s**.
- Reels get more than 4x the interactions of single images.
- Carousels get 9x the saves of single images.
- Posts with at least one hashtag got **31.7% fewer views** and 33.9% fewer interactions than the platform average.
- Questions in the post: +36.7% comments. Comment-focused calls to action: **+202.8% comments**.
- Most views arrive in the first 3 days.
- Source: https://metricool.com/press-release-instagram-study-2026/
- Confidence: **Med** (correlational; press-release level).

### Length

**B13. Instagram Reels views peak at 45–60 s.** Socialinsider, Jan–Jun 2026 (about 9.8M Reels).
- Views by length: 0–30 s 4,700 → 30–45 s 8,564 → **45–60 s 10,374** → 60–90 s 9,790 → 120–180 s 9,000 → >180 s 4,428.
- Reported engagement rate is highest at 45–60 s (0.35%) and lowest above 3 min (0.15%).
- Source: https://www.socialinsider.io/social-media-benchmarks/social-media-video-statistics ; https://socialinsider.io/blog/instagram-reels-length/
- Confidence: **Med**. Socialinsider calls the same figure "median" on one page and "average" on another.

**B14. TikTok views rise with length up to 2–3 minutes.** Socialinsider: 8.0M TikToks, Jan–Jun 2026.

| Length | Median views | Engagement rate by views |
|---|---|---|
| 0–15 s | 1,274 | 5.9% |
| 15–30 s | 1,000 | **6.0%** (highest) |
| 30–60 s | 2,200 | 4.2% (lowest) |
| 60–90 s | 7,200 | 4.8% |
| 90–120 s | 9,620 | 5.15% |
| **120–180 s** | **11,136** | 5.5% |
| >180 s | 10,150 | 5.9% |

- Source: https://www.socialinsider.io/blog/how-long-are-tiktok-videos/
- Confidence: **Med**.
- Strongly confounded by the Creator Rewards >1-minute incentive (A19) and by which accounts produce longer videos.

**B15. Facebook Reels views rise steadily with length; LinkedIn video peaks at 2–3 minutes.**
- Facebook Reels, average views: 2,825 at 0–30 s up to 4,220 at more than 180 s, with no drop-off.
- LinkedIn video peaks at 120–180 s (900 average views; sample 135,618 videos).
- Same source as B13.
- Confidence: **Med**.

**B16. An earlier study had longer Reels winning (now superseded).** Emplifi, 2023 data.
- Reels under 30 s: 6,145 median views. Reels of 30–90 s: 7,830.
- Source: https://emplifi.io/press/emplifi-reports-instagram-reels-outperformed-other-video-content-instagram-facebook-tiktok
- Confidence: **Med**, but **dated**. Consistent with B13 that "medium beats very short."

### Frequency, consistency and lifespan

**B17. TikTok posting frequency.** Buffer: 11.4M posts, 150K+ accounts, fixed-effects (within-account) regression. Oct 2025.
- Views per post versus posting once a week: 2–5 per week **+17%**; 6–10 per week **+29%**; 11+ per week **+34%**.
- **Median views stay flat at about 500.** The gain is in the tail: the p90/median ratio rises from 7.6x to 31.4x.
- Source: https://buffer.com/resources/how-often-should-you-post-on-tiktok/
- Confidence: **Med-High** (best-designed frequency study found).
- Coach message: frequency buys more lottery tickets, not a better typical post.

**B18. Instagram posting frequency.** Buffer: 2.1M feed posts, 102K accounts, fixed effects. Aug 13, 2025.
- Median reach per post versus 1–2 per week: 3–5 per week about +12%; 6–9 about +18%; 10+ about +24%.
- Weekly follower growth: +0.12% at 1–2 posts, up to +0.66% at 10+.
- Weeks with no posts were the worst for follower growth.
- Source: https://buffer.com/resources/how-often-to-post-on-instagram/
- Confidence: **Med-High**.

**B19. Consistency and replies.** Buffer, Jun 10, 2026.
- 26-week consistency study (100K+ users): posting in 20 or more of 26 weeks gave about **+450% engagement per post** versus posting in 4 or fewer weeks.
- Replying to comments (about 2M posts) was associated with higher engagement: Threads +42%, LinkedIn +30%, Instagram +21%, Facebook +9%.
- Source: https://buffer.com/resources/creator-growth-playbook/
- Confidence: **Med** (correlational; selection effects likely).

**B20. TikTok changes, Jan–Feb 2026 vs Jan–Feb 2025.** Metricool: 2.31M posts, 92K accounts. Published May 12, 2026.
- Views −31.3%, reach −28.7% YoY (saturation: video volume +72%).
- **96% of reach and about 98% of interactions arrive within 10 days.**
- For You page = **72.7% of views**.
- At least one hashtag: about +5% views and +9% interactions.
- Questions: +26% comments.
- Best window 6–9 pm, with a peak at 8 pm.
- Source: https://metricool.com/press-release-tiktok-study-2026/
- Confidence: **Med**.

**B21. TikTok vs Reels vs Shorts on views and shares.** Metricool short-video report: 6.18M videos, 375K accounts, Aug 2026.
- TikTok gets up to 42% more views than Reels and more than 6x Shorts.
- **Reels lead in shares across every account size.**
- Source: https://metricool.com/short-video-report/
- Confidence: **Med-Low** (headline figures only; full report gated).

### Timing (weak signal)

**B22. Best posting times.**
- Buffer 2026 Instagram (9.6M posts): Thu 9 am, Wed 12 pm, Wed 6 pm. https://buffer.com/resources/when-is-the-best-time-to-post-on-instagram
- Buffer 2026 TikTok (7.1M posts): Sun 9 am, Mon 1 pm, Sun 1 pm. https://buffer.com/resources/best-time-to-post-on-tiktok
- Sprout Social (about 2B engagements, about 307K profiles) recommends TikTok on weekday afternoons and calls weekends worst, which **directly contradicts** Buffer.
- Confidence: **Low as a lever**.
- Coach rule: use the creator's own hour-of-day medians after 4–6 weeks of data. Never present a universal "best time."

### Shares, entertainment and hashtags

**B23. Shares, an "Entertainment Score" and DMs.** Dash Social trend report, Jul 30, 2025.
- Shares grew from Q4 2023 to Q1 2025: TikTok **+60%**, Instagram +10%.
- Content with a proprietary "Entertainment Score" above 7.5 got 5x reach on TikTok and **14x on Reels** versus content scoring below 2.5.
- Instagram DM reply rate is 41%, versus 1.3% for comments.
- Source: https://www.dashsocial.com/press-release/dash-socials-trend-report-highlights-why-shares-are-emerging-as-a-top-kpi-for-brands
- Confidence: **Low-Med** (proprietary score, no stated sample).

**B24. Hashtag count does not influence Instagram distribution.**
- Socialinsider analysis of more than 75M posts. Consistent with A11 and B12.
- Source: cited via Hootsuite/Kontentino. https://kontentino.com/q-and-a/instagram-hashtags-reach/
- Confidence: **Med**.

### Captions and sound (older studies)

**B25. Captions and sound-off viewing.** Verizon Media / Publicis Media survey: 5,616 US adults, April 2019.
- **69%** watch video with sound off in public; 25% do so in private.
- 80% say they're more likely to finish a video when captions are available.
- Source: https://www.3playmedia.com/blog/verizon-media-and-publicis-media-find-viewers-want-captions/
- Confidence: **Med** (self-reported survey, 2019, pre-TikTok-dominance; **dated**).
- "85% of Facebook videos are watched without sound" (Digiday, 2016) is **outdated**. Don't use it.

**B26. Sound on TikTok.** TikTok/Kantar, Jan 2021.
- **88%** of users say sound is essential to the TikTok experience.
- Source: https://ads.tiktok.com/business/en-US/blog/kantar-report-how-brands-are-making-noise-and-driving-impact-with-sound-on-tiktok
- Confidence: **Med**. It is a survey of attitudes, not a measure of viewing behaviour, and it is **dated**.
- Note: Instagram's ranker explicitly uses "viewed with sound on" and an audio-reuse prediction (A2), which is the more current evidence that sound matters.

---

## (C) Practitioner consensus (weaker: present as heuristics)

**C1. Decisive hook within 1–2 s.**
- Show the payoff, the conflict or a pattern break visually *and* in on-screen text in frame 1. No logos or intros.
- Evidence link: A2 (<3 s prediction), A9 (skip rate), A21, A26, B11. The direction is platform-backed; the exact second count is folklore.

**C2. Re-hook every 3–5 s** (a visual change, a new text beat or a question). Practitioner lore only; no study found.

**C3. Loopable endings,** where the last 1–2 s flow into the first, raise rewatches.
- Rewatches count as views on all three platforms and feed watch time.
- No controlled study found. **Low**.

**C4. Design for "send-to-one-person."**
- Formats that work: relatable "this is so you," useful checklists, or "tag the friend who…" (without engagement bait).
- Evidence link: A1 and A2 (sends and off-platform shares are explicit targets); B21 (Reels lead in shares).
- Specific formats: **Low**.

**C5. Captions and on-screen text inside platform safe zones,** away from the bottom 20–25% and the right-hand UI rail.
- Keep text from covering most of the frame (A5).
- Pacing: 5–10 words per second (A21).

**C6. Keyword-rich captions and spoken keywords for in-app search.**
- TikTok's Creator Rewards "search value" criterion (A19) makes this partly platform-backed.
- Instagram content is indexable by Google since Jul 2025 (tracker).
- Specific lifts are unverified.

**C7. Trending audio for discovery.**
- No controlled study found; Hootsuite and other vendors give only general advice.
- Platform-backed only indirectly: the audio-reuse prediction (A2) and sound as "video information" (A17).
- Low-volume trending audio under a voiceover is a common tactic. Mind the YouTube Content ID constraint for Shorts over 1 minute (A24). **Low**.

**C8. Length = "as long as it needs to be, but no longer."**
- Attributed to Rene Ritchie (secondary). Consistent with A2's length-normalised watch-time prediction and A26.
- Data peaks: B13 for Reels, B14 for TikTok.

**C9. "Healthy" thresholds circulating online are unsupported.**
- Examples: skip rate under 40%; viewed vs swiped above 70–80%; share/reach of 1–2% (Creatorflow, https://creatorflow.so/blog/instagram-analytics-creators-metrics-guide/); TikTok share/view 0.41% (TT Calculator).
- Use them only as loose sanity checks. Rank against the creator's own distribution first.

**C10. Post consistently and reply to comments in the first hour.** Directionally supported by B19. The "first hour" window is folklore.

---

## Outdated, contradicted or unsupported claims (the coach must not repeat these)

| Claim | Status | Why |
|---|---|---|
| "Sends count 3–5x likes" | **Unsupported** | Mosseri said "slightly more important" (A1) |
| "Skip rate is IG's #1 factor; keep it under 30–40%" | **Unsupported** | Not in Meta docs; real medians are 60–65% (B11) |
| "Hashtags boost reach; use 20–30" | **Contradicted** | Mosseri (A11), 5-tag cap, Metricool −31.7% views (B12). TikTok shows only a small +5% (B20) |
| "Reels over 90 s are penalised" / "Shorts must be ≤60 s" | **Outdated** | 3-minute limits since Jan 2025 / Oct 2024 (A8, A24) |
| "Original content gets 40–60% more distribution" | **Unsupported** | No quantified effect published |
| "Reposting more than 10 Reels in 30 days triggers a penalty" | **Unverified** | Not in Instagram's announcement (A3) |
| "Follower count drives TikTok reach" | **Contradicted** | TikTok: not a direct factor (A17) |
| "85% of videos are watched on mute" | **Outdated** | 2016 figure; 2019 survey says 69% in public (B25) |
| "Captions = +12% watch time" / "65% who pass 3 s watch 10 s" | **Outdated / unsourced** | Old Facebook ads data repeated without a primary source |
| Universal "best time to post" | **Contradicted** | Buffer and Sprout disagree (B22) |
| Shorts view counts comparable before and after Mar 31, 2025 | **Wrong** | Counting changed (A25) |
| "Trial Reels underperforming means a bad idea" | **Misread** | Compare trial to trial (A10) |
| "Captions, borders, speed changes or a watermark make a repost original" | **Contradicted** | Meta (A14, A15), Instagram (A4), YouTube "template-based bulk changes" (A27) |
| "Monthly Instagram algorithm updates" / shadowban theories | **Unsupported** | Instagram announces features and policies; the mechanism is recommendation eligibility, visible in Account Status |

---

## Why reposts and duplicates get suppressed (implications for Clone8 "originals")

**1. Duplicate detection is content-level and explicit on every major platform.**
- Instagram replaces identical copies with the original (A3).
- Facebook reduces distribution of duplicate copies (A15).
- TikTok doesn't recommend duplicated content (A17).
- YouTube cuts reach for re-uploads and "template-based bulk changes" (A27).

**2. Low-value transformations are named as not enough.**
- Captions, borders, speed changes, watermarks, stitching clips, narrating what's on screen (A14, A15).
- Speed changes or crediting screenshots (A4).
- Voiceovers describing the screen, "minor technical edits," "template-based bulk changes" (A27).
- **A variant pipeline that only re-crops, re-captions, re-speeds or re-scores music should be assumed to be fingerprinted as a duplicate.**

**3. Penalties are account-level, not only post-level.**
- Instagram: account ineligible for recommendations (A4, A5).
- Facebook: non-recommendable and demonetised (A14).
- YouTube: reach re-evaluated per channel (A27).
- TikTok: For You ineligibility and loss of Creator Rewards (A20).
- One aggressive variant strategy can therefore depress *all* of an account's reach to non-followers.

**4. Followers are not affected; discovery is.**
- Every originality penalty removes non-follower recommendation while followers still see posts.
- Since growth comes from non-follower reach (sends, A1), this is the expensive part.

**5. Same-owner cross-posting is allowed. Watermarks are not.**
- Facebook explicitly allows sharing the same content across your *own* Pages and profiles (A15).
- Instagram allows your own logo but demotes other apps' watermarks (A6).
- Clone8 should strip platform watermarks and avoid posting byte-identical files across different accounts.

**6. What counts as genuinely new, per the platforms.**
- New commentary, analysis or storyline (A14, A27).
- New voiceover with a point of view, creative edits that change the meaning, humour, cultural framing (A4).
- **Engineering inference, unconfirmed:** variants should differ in *substance*, for example a different hook, script, angle, B-roll order or narrative. Cosmetic differences are not enough.

**7. AI disclosure.**
- Instagram: label AI-persona profiles or lose recommendations (A12).
- TikTok: label realistic AI content; users can dial AI content down (A22).

---

## Compact benchmark table: engagement and share rates by platform and tier

**Read the denominator column before comparing anything.**

| Platform | Metric (denominator) | Tier | Value | Source (date, n) | Confidence |
|---|---|---|---|---|---|
| TikTok | Engagement rate (followers) | brands 1K–1M | 3.70% (2025) → 2.60% (2026) | Socialinsider, Aug 2026, 35.6M videos | Med |
| TikTok | Engagement rate (views) | brands, by length | 4.2–6.0% | Socialinsider, Jan–Jun 2026, 8.0M | Med |
| TikTok | Engagement rate (views) | big brands | 3.9–4.2% | Dash Social 2026 | Med |
| TikTok | Engagement rate (reach/impressions, median) | Buffer users | 4.86% | Buffer, Jan 2026 | Med |
| TikTok | Engagement rate (followers, median) | 150 companies per industry | ~1.73% (2025); ~2.01% (2026, secondary) | Rival IQ | Low-Med |
| TikTok | Engagement rate | nano 1–10K | 10.3% / 11.9% (conflicting) | HypeAuditor 2025, 104M accts | Low-Med |
| TikTok | Avg shares ÷ avg views (ratio of means) | brands | ~3.8% (248 / 6,496), outlier-skewed | Socialinsider 2025 | Low |
| TikTok | Share/view (median-ish) | all | ~0.41% | TT Calculator | Low |
| IG Reels | Engagement rate (followers) | brands 1K–1M | 0.48% → 0.45% | Socialinsider 2026 | Med |
| IG Reels | Engagement rate (followers) by industry | brands | 0.05–0.38% | Socialinsider 2026 | Med |
| IG Reels | Engagement rate by industry | 3.3K brands | 0.1–0.5% | Dash Social H2 2025 | Med |
| Instagram | Engagement rate (reach, median) | <1K / 10–50K / all | ~5% / ~3.7% / 4.3% | Buffer, 27M posts | Med |
| Instagram | Engagement rate | nano 1–10K | 2.19% | HypeAuditor 2025 | Low-Med |
| IG Reels | Reach rate (followers) | 1–5K → 100K–1M | 9.78% → 5.00% | Socialinsider 2026, 9.8M | Med |
| IG Reels | Skip rate (first 3 s) | 1–5K → 100K–1M | 65.5% → 60.5% | Socialinsider 2026 | Med |
| IG Reels | Shares ÷ reach (derived from averages) | 3.3K brands | ~0.7% (1.3K / 182K) | Dash Social H2 2025 | Low-Med |
| IG Reels | Saves ÷ reach (derived) | 3.3K brands | ~0.34% | Dash Social H2 2025 | Low-Med |
| IG Reels | Shares/reach "strong" | rule of thumb | 1–2% | Creatorflow | Low |
| YT Shorts | Engagement rate (followers) | brands 1K–1M | 0.27% → 0.30% | Socialinsider 2026, 7.5M | Med |
| YT Shorts | Viewed vs swiped "good" | rule of thumb | 70–80% viewed | creator blogs | Low |
| Facebook | Engagement rate (followers) | brands | 0.15% | Socialinsider 2025 | Med |
| Facebook | Engagement rate (reach, median) | Buffer users | 3.6% | Buffer, 52M posts | Med |
| LinkedIn | Engagement rate (impressions, median) | Buffer users | 6.5% | Buffer | Med-Low |
| Threads | Video engagement rate | Buffer users | 5.55% (highest format) | Buffer, Jun 2026 | Low-Med |

**Gap:** no study I found publishes **share rate by follower tier** for any platform. The coach should compute this from the creator's own data and pooled Clone8 data.

---

## Metrics the coach should compute from a creator's own post data

Normalise everything *within creator* first: percentile or z-score versus that creator's trailing 30–90-day distribution, segmented by platform and length bucket. Use outside benchmarks only as secondary context.

Notes for the table below:
- Instagram exposes skip rate, retention, shares, saves and reach. Its API exposes some of these.
- TikTok Studio exposes average watch time, percent who watched the full video, a retention curve and the traffic source.
- YouTube Studio exposes viewed vs swiped away, engaged views and the retention curve.

| Metric | Formula | Maps to which disclosed signal | Notes |
|---|---|---|---|
| **Share rate** | shares (DM sends + Story reshares + external) ÷ reach (IG) or ÷ views (TikTok, Shorts) | IG "sends per reach" (A1); P(reshare), P(share off-IG) (A2); TikTok shares as interaction (A17) | Key non-follower growth signal. Track DM sends separately where available |
| **Like rate** | likes ÷ reach | IG "likes per reach" (A1, follower reach) | Diagnoses follower satisfaction |
| **Skip / swipe rate** | IG skip rate; YT 1 − "viewed %"; TikTok proxy 1 − (viewers past 2–3 s ÷ plays) from the retention curve | IG P(watch <3 s) (A2, A9); YT viewed vs swiped (A26) | Benchmark against own median, then B11 (60–65% typical on IG) |
| **Length-normalised watch time** | avg watch time ÷ duration, as a percentile vs the creator's own posts in the same length bucket | IG P(watch more than 95% of users of same-length reels) (A2); TikTok completion (A17) | Never compare raw seconds across lengths |
| **Completion rate** | % watched full video (TikTok) or end-of-video retention (IG, YT) | TikTok "finishes watching… beginning to end" (A17) | Strongest TikTok-stated factor |
| **Hook retention** | % of viewers remaining at 3 s and 5 s, from the retention curve | A2, A9, A21 | Pinpoints a hook problem vs a mid-video problem |
| **Rewatch ratio** | views ÷ reach (IG), views ÷ unique viewers (TikTok), views ÷ engaged views (YT) | Watch time incl. replays (A1); YT start-based counting (A25) | High ratio = loopability. On YT it also shows inflation from start-counting |
| **Engaged-view ratio (YT)** | engaged views ÷ views | Pre-2025 view definition; YPP basis (A25) | Clean proxy for "didn't swipe instantly" |
| **Views vs account median** | log(views ÷ trailing median views), or z(log1p views) | Staged distribution (A3, A26): breakouts show up as outliers | Matches Buffer's tail finding (B17). The existing Tradvio leader score `0.7*z(log1p views)+0.3*z(ER)` fits here |
| **Outlier rate** | % of posts above the creator's own p90 views | Buffer B17: frequency raises the tail, not the median | A better KPI than mean views |
| **Non-follower share** | non-follower reach ÷ total reach (IG); For You views ÷ total views (TikTok) | Recommendation eligibility (A3–A5, A20); TikTok baseline about 72.7% from For You (B20) | A sudden drop flags possible originality or recommendation ineligibility. Also check Account Status |
| **Follows per 1K views** | new follows attributed to post ÷ views × 1000 | IG P(follow author), using followers gained through the reel (A2) | Separates "viral but empty" from audience-building posts |
| **Save rate** | saves ÷ reach | IG "Interested" prediction uses saves (A2) | Carousels win on saves (B12). Weight below shares for Reels |
| **Comment rate** | comments ÷ reach | IG P(comment) (A2); TikTok interaction (A17) | Not in Mosseri's top 3. Lower weight. Prompts lift it (B12, B20) |
| **Audio reuse** | "use audio" count, or uses of the creator's original sound | IG P(use audio) (A2) | Mainly for original-sound creators |
| **Velocity / lifespan** | % of 10-day views reached by 24 h, 72 h and 10 d | Freshness: about 45% of recommended IG Reels are under 1 day old (A7); TikTok 96% of reach in 10 days (B20) | Judge a post at 72 h; don't wait weeks |
| **Consistency** | active posting weeks in last 26; posts/week | Buffer B17–B19 | Coach on cadence before content tweaks |
| **Trial-vs-trial lift (IG)** | trial reel metrics vs the creator's other trials | A10 | Never compare trials against regular posts |
| **Originality risk flags** | (a) perceptual-hash or audio-fingerprint similarity to the creator's own prior posts and across Clone8 accounts; (b) watermark/logo detection; (c) share of last 30 days' posts that are repurposed; (d) changes limited to captions, borders, speed or template | A3–A6, A14, A15, A20, A27, A28 | Gate publishing on this; it protects account-level eligibility |
| **AI disclosure compliance** | AI label present on AI-persona content | A12, A22 | Hard rule, not a score |

**Suggested composite (optional).** A within-creator "distribution score" for Reels:
- 0.35 · z(share rate)
- 0.30 · z(length-normalised watch time)
- 0.15 · z(like rate)
- 0.10 · z(−skip rate)
- 0.10 · z(follows per 1K)

**These weights are my synthesis of A1/A2, not published by Meta. Label them as such in-product.** For TikTok, swap like rate for completion rate.

---

## Not verified / gaps

- I could not read TikTok's Creator Academy originality page directly (it did not render); A20 rests on consistent third-party summaries.
- The Rival IQ 2025/2026 PDFs and the Metricool full reports were not read directly; their figures came from press releases and secondary pages.
- No primary YouTube help page on how Shorts are *ranked*. A26 rests on a 2023 Creator Insider interview reported secondhand.
- No controlled study found on trending audio, loops, re-hooks or on-screen text for organic short-form video.
- No quantification of the originality penalty's size on any platform.
- The single-source claim that Mosseri said on Oct 23, 2026 that sends matter "a lot more" than comments is **unverified** and was excluded from (A).
- Dash Social's derived share and save ratios are ratios of averages, not medians.
- Most benchmark panels are brand accounts. Creator-account baselines will likely differ, so build them from Clone8 pooled data.
