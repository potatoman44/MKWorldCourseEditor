// Custom Courses: a plugin for mkw-recomp (plugin API 4), game 1.8.0.
// Press + on the VS / Time Trials map or route list to open the list: folders (tracks) and their courses (routes, variants, connectors). D-pad / stick to move,
// A to open a folder or pick a course, B to go back, + to close. The pick makes every VS / Time Trials race load that
// course, whatever stage and route you choose, until "Normal courses" turns it off.
//
// courses.txt in the mod's folder:  [Folder name]  starts a folder;  Shown name<TAB>CourseName  is a course in it
// (CourseName as in Gyml/CourseGParam, e.g. Race_WestCity_B_00).  # starts a comment.
#include "mkw_plugin.h"
#include <stdio.h>
#include <string.h>
#include <windows.h>


static const MkwPluginApi *A;
static uint64_t base_main;

// ---------------------------------------------------------------- the list
#define MAXF 128
#define MAXC 64
typedef struct { char name[64]; char course[64]; uint32_t hash; } Course;
typedef struct { char name[64]; Course c[MAXC]; int n; } Folder;
static Folder F[MAXF]; static int nf;
static int level, fsel, csel, cur_f = -1, cur_c = -1;   // level 0: folders, 1: a folder's courses
static volatile int open_;

static uint32_t mmh3(const char *s) {   // MurmurHash3 x86 32, seed 0: the game's names -> ids
    const uint8_t *d = (const uint8_t *)s; size_t len = strlen(s); uint32_t h = 0, k;
    const uint32_t c1 = 0xcc9e2d51, c2 = 0x1b873593; size_t i = 0;
    for (; i + 4 <= len; i += 4) { memcpy(&k, d + i, 4); k *= c1; k = (k << 15) | (k >> 17); k *= c2; h ^= k; h = (h << 13) | (h >> 19); h = h * 5 + 0xe6546b64; }
    k = 0;
    switch (len & 3) {
    case 3: k ^= (uint32_t)d[i + 2] << 16; /* fall through */
    case 2: k ^= (uint32_t)d[i + 1] << 8;  /* fall through */
    case 1: k ^= d[i]; k *= c1; k = (k << 15) | (k >> 17); k *= c2; h ^= k;
    }
    h ^= (uint32_t)len; h ^= h >> 16; h *= 0x85ebca6b; h ^= h >> 13; h *= 0xc2b2ae35; h ^= h >> 16; return h;
}

static void load_list(void) {
    char path[1024]; snprintf(path, sizeof path, "%s/courses.txt", A->mod_dir);
    FILE *f = fopen(path, "rb"); Folder *cf = NULL;
    if (f) {
        char line[256];
        while (fgets(line, sizeof line, f)) {
            size_t n = strlen(line); while (n && (line[n - 1] == '\n' || line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = 0;
            if (!n || line[0] == '#') continue;
            if (line[0] == '[') { if (nf >= MAXF) break; cf = &F[nf++]; char *e = strchr(line, ']'); if (e) *e = 0; snprintf(cf->name, sizeof cf->name, "%s", line + 1); continue; }
            if (!cf) { if (nf >= MAXF) break; cf = &F[nf++]; snprintf(cf->name, sizeof cf->name, "Courses"); }
            if (cf->n >= MAXC) continue;
            char *tab = strchr(line, '\t'); Course *c = &cf->c[cf->n++];
            if (tab) { *tab = 0; snprintf(c->name, sizeof c->name, "%s", line); snprintf(c->course, sizeof c->course, "%s", tab + 1); }
            else { snprintf(c->name, sizeof c->name, "%s", line); snprintf(c->course, sizeof c->course, "%s", line); }
            c->hash = mmh3(c->course);
        }
        fclose(f);
    }
    A->log("custom courses: %d folders (%s)", nf, path);
}

// ---------------------------------------------------------------- the course the game is told to load
// The VS / Time Trials menus hand the chosen course to the race as one blackboard value, S32 "CourseId" (the mmh3 of the
// course name). PreloadCourse and RequestPlay read it; both are reached through vtables, so overriding them lets the
// plugin set CourseId just before the game reads it. Found in the 1.8.0 code; the same hook works as an exefs patch.
#define OFF_REQPLAY_FN   0xc830d0ull   // AIGlobalSeqRequestPlay, vtable slot 28
#define OFF_PRELOAD_FN   0xd02d60ull   // AIGlobalSeqPreloadCourse, vtable slot 28
#define OFF_STR_COURSEID 0x2c38131ull  // the game's own "CourseId"
static volatile int native_on, native_saw_route, native_page, native_pages, want_page = -1;
static void restore_lists(void);
static volatile uint32_t want;         // the hash to race, 0: whatever the menu picked
static const char *volatile name_holder;

static void set_course(MkwCpu *c, const char *who) {
    uint32_t h = want;
    if (!h) return;
    uint64_t node = c->x[0];
    if (!node) return;
    uint64_t owner = *(uint64_t *)mkw_guest_ptr(node + 8);
    if (!owner) return;
    uint64_t bb = *(uint64_t *)mkw_guest_ptr(owner + 0x20);
    if (!bb) return;
    uint64_t vt = *(uint64_t *)mkw_guest_ptr(bb);
    name_holder = (const char *)mkw_guest_ptr(base_main + OFF_STR_COURSEID);
    uint64_t holder = (uint64_t)(uintptr_t)&name_holder;
    if ((int32_t)A->call(c, *(uint64_t *)mkw_guest_ptr(vt + 0x288), 2, bb, holder) < 0) return;   // no CourseId here
    A->call(c, *(uint64_t *)mkw_guest_ptr(vt + 0x30), 3, bb, holder, (uint64_t)h);
    A->log("custom courses: %s: CourseId = %u", who, h);
}
static void on_request_play(MkwCpu *c) { if (native_on) { restore_lists(); native_on = 0; native_saw_route = 0; want_page = -1; native_page = 0; } uint64_t s[9]; memcpy(s, c->x, sizeof s); set_course(c, "RequestPlay"); memcpy(c->x, s, sizeof s); c->x[0] = A->call_original(c); }
static void on_preload_course(MkwCpu *c) { uint64_t s[9]; memcpy(s, c->x, sizeof s); set_course(c, "PreloadCourse"); memcpy(c->x, s, sizeof s); c->x[0] = A->call_original(c); }

// Where + opens the list: only while the VS / Time Trials map (VSStageSelect) or the route list (VSCourseSelect) is
// running. Their per-frame methods (vtable slot 29) stamp the time; + works for a moment after the last stamp.
#define OFF_STAGESEL_UPDATE  0x1d0cec0ull
#define OFF_COURSESEL_UPDATE 0x1d0a540ull
static volatile ULONGLONG stage_seen, course_seen;
static int on_map(void) { ULONGLONG t = GetTickCount64(); return t - stage_seen < 250 && t - course_seen > 250; }

// ---------------------------------------------------------------- the native list (the game's own route screen)
// The route screen asks a course-list manager ([main+0x379aca0]+0xb8) for the stage's courses (main+0x1d8baa0): the
// stage record's data object (+0x1a8, then +0x150) holds the stage's own courses (a chunk at +0x80: u32* at +0x18,
// count at +0x24, next chunk at +0x10) and the connectors arriving there (a chunk at +0x30: count at +8, next at +0x18).
// Pressing + on the map swaps every stage's lists for ours (one entry per folder: its first course) and the connectors
// out, presses A so the game opens the route screen of the stage under the cursor, and puts everything back once the
// route screen is left (back to the map, or the race starts).
#define OFF_LISTMGR 0x379aca0ull
#define REC_SIZE 0x1b8
#define MAXREC 64
typedef struct { uint64_t own, con; uint64_t own_arr, own_next, con_next; uint32_t own_cnt, con_cnt; } Saved;
static Saved saved[MAXREC]; static int nsaved;
static uint32_t natarr[64]; static int natn;
static volatile int native_req, native_next;
#define PAGE_N 8    // entries per page: 10 and 30 crashed the route screen (its list widget held only 9 items)
static void swap_lists(void) {
    uint64_t g = *(uint64_t *)mkw_guest_ptr(base_main + OFF_LISTMGR); if (!g) { A->log("custom courses: no list manager"); return; }
    uint64_t m = *(uint64_t *)mkw_guest_ptr(g + 0xb8); if (!m) { A->log("custom courses: no list manager (+0xb8)"); return; }
    int32_t n = *(int32_t *)mkw_guest_ptr(m + 0x58); uint64_t recs = *(uint64_t *)mkw_guest_ptr(m + 0x60);
    natn = 0; int k = 0, first = native_page * PAGE_N;
    for (int f = 0; f < nf; f++) if (F[f].n) { if (k >= first && natn < PAGE_N) natarr[natn++] = F[f].c[0].hash; k++; }
    native_pages = (k + PAGE_N - 1) / PAGE_N;
    nsaved = 0; int skipped = 0;
    for (int i = 0; i < n && nsaved < MAXREC; i++) {
        uint64_t sd = *(uint64_t *)mkw_guest_ptr(recs + (uint64_t)i * REC_SIZE + 0x1a8); if (!sd) continue;
        uint64_t t = *(uint64_t *)mkw_guest_ptr(sd + 0x150); if (!t) continue;
        uint8_t own_flag = *(uint8_t *)mkw_guest_ptr(t + 0xc6), con_flag = *(uint8_t *)mkw_guest_ptr(t + 0xcb);
        if (!(own_flag & 1)) { skipped++; continue; }
        Saved *s = &saved[nsaved++]; memset(s, 0, sizeof *s);
        s->own = t + 0x80;
        s->own_arr = *(uint64_t *)mkw_guest_ptr(s->own + 0x18); s->own_cnt = *(uint32_t *)mkw_guest_ptr(s->own + 0x24); s->own_next = *(uint64_t *)mkw_guest_ptr(s->own + 0x10);
        *(uint64_t *)mkw_guest_ptr(s->own + 0x18) = (uint64_t)(uintptr_t)natarr; *(uint32_t *)mkw_guest_ptr(s->own + 0x24) = (uint32_t)natn; *(uint64_t *)mkw_guest_ptr(s->own + 0x10) = 0;
        if (con_flag & 1) {
            s->con = t + 0x30;
            s->con_cnt = *(uint32_t *)mkw_guest_ptr(s->con + 8); s->con_next = *(uint64_t *)mkw_guest_ptr(s->con + 0x18);
            *(uint32_t *)mkw_guest_ptr(s->con + 8) = 0; *(uint64_t *)mkw_guest_ptr(s->con + 0x18) = 0;
        }
    }
    A->log("custom courses: native list on: page %d/%d, %d entries in %d of %d stages (%d skipped)", native_page + 1, native_pages, natn, nsaved, n, skipped);
    { char msg[96]; snprintf(msg, sizeof msg, "Tracks: page %d of %d   (+: next page)", native_page + 1, native_pages); A->notice(msg, 4); }
}
static void restore_lists(void) {
    for (int i = 0; i < nsaved; i++) {
        Saved *s = &saved[i];
        *(uint64_t *)mkw_guest_ptr(s->own + 0x18) = s->own_arr; *(uint32_t *)mkw_guest_ptr(s->own + 0x24) = s->own_cnt; *(uint64_t *)mkw_guest_ptr(s->own + 0x10) = s->own_next;
        if (s->con) { *(uint32_t *)mkw_guest_ptr(s->con + 8) = s->con_cnt; *(uint64_t *)mkw_guest_ptr(s->con + 0x18) = s->con_next; }
    }
    if (nsaved) A->log("custom courses: native list off (%d stages restored)", nsaved);
    nsaved = 0;
}
static volatile ULONGLONG press_from2, press_to2, pressB_from, pressB_to;
static uint64_t prevp;
static volatile ULONGLONG reopen_at;   // the next page opens a moment after the map is back (reopening at once crashed)
// ---- page test: open a game page by its UIView event (UIView_Page_RequestIn / RequestOut), as the menus' own sequence
// nodes do through main+0x954fd0(node, &event, &page, &view). Page 50 is what the Battle menu opens (BattleListup).
#define OFF_SEND_EVENT 0x954fd0ull
#define EV_PAGE_IN  0xd854b61bu   /* mmh3("UIView_Page_RequestIn") */
#define EV_PAGE_OUT 0xbbd6e820u   /* mmh3("UIView_Page_RequestOut") */
static volatile int test_page = 50, page_open;
static uint32_t ev_hash, ev_page; static int32_t ev_view;
static int map_hook(MkwCpu *c);
static void on_stage_update(MkwCpu *c) {
    stage_seen = GetTickCount64();
    if (map_hook(c)) return;
    c->x[0] = A->call_original(c);
}
static void on_course_update(MkwCpu *c) { course_seen = GetTickCount64(); if (native_on) native_saw_route = 1; c->x[0] = A->call_original(c); }

static volatile ULONGLONG press_from, press_to;   // A held for the game for a moment: picks the stage under the map's cursor

static void apply(uint32_t h) {
    if (!base_main) { A->notice("Custom courses: the game isn't loaded yet", 4); return; }
    want = h;
    char msg[192];
    if (h && cur_f >= 0) snprintf(msg, sizeof msg, "Next race: %s - %s", F[cur_f].name, F[cur_f].c[cur_c].name);
    else snprintf(msg, sizeof msg, "Custom courses off: the map's own courses again");
    A->notice(msg, 6);
    if (h) { ULONGLONG t = GetTickCount64(); press_from = t + 150; press_to = t + 300; }
}

// ---------------------------------------------------------------- drawing and the pad
static int rows(void) { return level == 0 ? nf + 1 : F[fsel].n; }

static void draw(const MkwOverlay *o, void *user) {
    (void)user;
    if (!open_) return;
    float s = o->scale, lh = o->line_height, pad = 24 * s;
    int n = rows(), show = n < 12 ? n : 12, sel = level == 0 ? fsel : csel;
    float w = 680 * s, h = pad * 2 + lh * (show + 3.4f), x0 = (o->width - w) / 2, y0 = (o->height - h) / 2;
    o->rect(0, 0, o->width, o->height, 0x00000088u, 0);
    o->rect(x0, y0, x0 + w, y0 + h, 0x1b2333F2u, 14 * s);
    char title[128];
    if (level == 0) snprintf(title, sizeof title, "Custom courses"); else snprintf(title, sizeof title, "Custom courses  >  %s", F[fsel].name);
    o->text(x0 + pad, y0 + pad, 0xFFD84AFFu, title);
    int first = sel - (show - 1) < 0 ? 0 : sel - (show - 1);
    for (int r = 0; r < show && first + r < n; r++) {
        int i = first + r; float y = y0 + pad + lh * (1.7f + r); char line[160];
        if (i == sel) o->rect(x0 + pad * 0.5f, y - 2 * s, x0 + w - pad * 0.5f, y + lh + 2 * s, 0x3A6FD8FFu, 6 * s);
        if (level == 0) {
            if (i == nf) snprintf(line, sizeof line, "%sNormal courses (turn this off)", cur_f < 0 ? "> " : "  ");
            else snprintf(line, sizeof line, "%s%s  (%d)", i == cur_f ? "> " : "  ", F[i].name, F[i].n);
        } else snprintf(line, sizeof line, "%s%s", (fsel == cur_f && i == cur_c) ? "> " : "  ", F[fsel].c[i].name);
        o->text(x0 + pad, y, 0xFFFFFFFFu, line);
    }
    o->text(x0 + pad, y0 + h - pad - lh, 0xA8B3C7FFu, level == 0 ? "A: open   B / +: close" : "A: race this   B: back   +: close");
}


// ---- research probe: the Battle course picker's scroll list (UIPageBattleCourseSelect, list at page+0xbe0)
static volatile uint64_t bpage; static uint32_t lastw[96]; static int have_last;
// The picker's scroll list was made with room for 24 items (+0x18 = capacity, +0x20 = the 0x50-byte items, +0x30 =
// the items in use, +0x28 = how many): a longer course list ran past it. Give it room for 64 before it is filled.
#define LIST_OFF 0xbe0
#define BIG_CAP 320
static uint8_t big_items[BIG_CAP * 0x50] __attribute__((aligned(16)));

// ---- course data list (UI ctx +0x4a0): +0x88 count, +0x8c capacity, +0x90 pointer array, +0x98 free-list of 0x18-byte nodes.
// BattleListup fills it through 0x244fef0, which stops at the capacity (24). Grow it while the picker runs, put it back on leave.
#define OFF_CTXGLOBAL 0x37b83f8ull
#define DL_CAP 512
static uint64_t dl_arr[DL_CAP]; static uint8_t dl_nodes[DL_CAP][0x18];
static uint64_t dl_list, dl_orig_arr; static int32_t dl_orig_cap; static uint64_t dl_orig_nodes[DL_CAP]; static int dl_norig;
static uint64_t ui_data_list(void) {
    uint64_t g = *(uint64_t *)mkw_guest_ptr(base_main + OFF_CTXGLOBAL); if (!g) return 0;
    uint64_t x9 = *(uint64_t *)mkw_guest_ptr(g + 0xe0); if (x9 == g + 0xd8) return 0;
    int32_t off = *(int32_t *)mkw_guest_ptr(g + 0xec);
    uint64_t ctx = *(uint64_t *)mkw_guest_ptr(x9 - off + 0x20); if (!ctx) return 0;
    return *(uint64_t *)mkw_guest_ptr(ctx + 0x4a0);
}
#define U64(a) (*(uint64_t *)mkw_guest_ptr(a))
#define I32(a) (*(int32_t *)mkw_guest_ptr(a))
static void dl_grow(void) {
    uint64_t L = ui_data_list(); if (!L) return;
    int32_t cap = I32(L + 0x8c), cnt = I32(L + 0x88); uint64_t arr = U64(L + 0x90);
    if (cap <= 0 || cap >= DL_CAP || !arr || arr == (uint64_t)(uintptr_t)dl_arr || cnt < 0 || cnt > cap) return;
    for (int i = 0; i < cnt; i++) dl_arr[i] = U64(arr + 8ull * i);          // keep what's in the list
    uint64_t head = U64(L + 0x98);
    for (int i = 0; i < DL_CAP - cap; i++) { uint64_t n = (uint64_t)(uintptr_t)dl_nodes[i]; U64(n) = head; head = n; }
    U64(L + 0x98) = head; U64(L + 0x90) = (uint64_t)(uintptr_t)dl_arr; I32(L + 0x8c) = DL_CAP; dl_list = L;
    A->log("custom courses: course data list grown from %d to %d (%d entries kept)", cap, DL_CAP, cnt);
}
// ---- two-level picker: the list holds every course (Coin UIInfo); the plugin keeps the ones for the screen shown.
// Level 1: each folder's first course. Level 2: every course of the picked folder (no connectors in Time Trials).
// The AINB has two BattleListup nodes: 50 (level 1, Next -> 51) and 51 (level 2, returns -> 50).
static void cap_bpage(MkwCpu *c);
typedef struct { uint8_t d[0x18]; } Entry;          // as in a node: u32 course id, pad, two pointers
static Entry snap[DL_CAP]; static uint32_t snap_id[DL_CAP]; static int nsnap;
static int pk_level = 1, pk_folder = -1, pk_tt, pk_l1_left; static uint64_t pk_l1node, pk_lastleave; static ULONGLONG pk_leave_t;
static int folder_of(uint32_t id) { for (int i = 0; i < nf; i++) for (int j = 0; j < F[i].n; j++) if (F[i].c[j].hash == id) return i; return -1; }
static int is_connector(const Course *c) { return strncmp(c->course, "InterStage", 10) == 0; }
static int want_ids(uint32_t *out) {
    int n = 0;
    if (pk_level == 1 || pk_folder < 0) { for (int i = 0; i < nf && n < DL_CAP; i++) if (F[i].n) out[n++] = F[i].c[0].hash; }
    else for (int j = 0; j < F[pk_folder].n && n < DL_CAP; j++) { if (pk_tt && is_connector(&F[pk_folder].c[j])) continue; out[n++] = F[pk_folder].c[j].hash; }
    return n;
}
// The name a course shows comes from its UI record's label (2430ca0(&id) gives the address of that record's label
// pointer). On a second screen the location's own course points at label "1800" ("Normal"); put back otherwise.
static const char normal_label[] = "1800"; static uint64_t nl_field, nl_orig; static uint32_t nl_id;
static void normal_label_set(MkwCpu *c, uint32_t id) {
    if (nl_field && nl_id == id) return;
    if (nl_field) { U64(nl_field) = nl_orig; nl_field = 0; }
    if (!c || !id) return;
    static uint32_t idbuf; idbuf = id;
    uint64_t f = A->call(c, base_main + 0x2430ca0, 1, (uint64_t)(uintptr_t)&idbuf);
    if (!f || f == base_main + 0x352b640) return;
    uint64_t str = U64(f); if (!str) return;
    const char *sv = (const char *)mkw_guest_ptr(str); if (strncmp(sv, "18", 2) != 0) { A->log("custom courses: label for %u is '%.16s', left alone", id, sv); return; }
    nl_field = f; nl_orig = str; nl_id = id; U64(f) = (uint64_t)(uintptr_t)normal_label;
}
static void dl_filter_c(MkwCpu *c, const char *why);
static void dl_filter(const char *why) { dl_filter_c(NULL, why); }
static void dl_filter_c(MkwCpu *c, const char *why) {
    if (c) normal_label_set(c, (pk_level == 2 && pk_folder >= 0 && F[pk_folder].n > 1) ? F[pk_folder].c[0].hash : 0);
    uint64_t L = dl_list; if (!L || U64(L + 0x90) != (uint64_t)(uintptr_t)dl_arr) return;
    int cnt = I32(L + 0x88); if (cnt < 0 || cnt > DL_CAP) return;
    for (int i = 0; i < cnt; i++) {                      // learn every entry the game has made
        uint64_t nd = dl_arr[i]; uint32_t id = *(uint32_t *)mkw_guest_ptr(nd); int k;
        for (k = 0; k < nsnap && snap_id[k] != id; k++) ;
        if (k == nsnap) { if (nsnap >= DL_CAP) continue; nsnap++; }
        snap_id[k] = id; memcpy(snap[k].d, mkw_guest_ptr(nd), 0x18);
    }
    static uint32_t want_l[DL_CAP]; int wn = want_ids(want_l), m = 0; static uint32_t have[DL_CAP];
    for (int i = 0; i < wn; i++) { int k; for (k = 0; k < nsnap && snap_id[k] != want_l[i]; k++) ; if (k < nsnap) have[m++] = want_l[i]; }
    if (!m) return;                                      // nothing known yet: leave the game's list alone
    int same = (cnt == m); for (int i = 0; same && i < m; i++) if (*(uint32_t *)mkw_guest_ptr(dl_arr[i]) != have[i]) same = 0;
    if (same) return;
    for (int i = 0; i < cnt; i++) { uint64_t nd = dl_arr[i]; U64(nd) = U64(L + 0x98); U64(L + 0x98) = nd; }
    int n = 0;
    for (int i = 0; i < m; i++) {
        uint64_t nd = U64(L + 0x98); if (!nd) break; U64(L + 0x98) = U64(nd);
        int k; for (k = 0; snap_id[k] != have[i]; k++) ;
        memcpy(mkw_guest_ptr(nd), snap[k].d, 0x18); dl_arr[n++] = nd;
    }
    I32(L + 0x88) = n;
    A->log("custom courses: picker level %d%s%s: %d of %d entries (%s)", pk_level, pk_level == 2 ? " for " : "", pk_level == 2 && pk_folder >= 0 ? F[pk_folder].name : "", n, cnt, why);
}
static int listup_on;
static void on_listup_enter(MkwCpu *c) {
    uint64_t node = c->x[0];
    // level 2 is the node entered right after level 1's node left (its Next); anything else is level 1
    if (pk_l1node && node != pk_l1node && pk_lastleave == pk_l1node && GetTickCount64() - pk_leave_t < 1500 && pk_folder >= 0) pk_level = 2;
    else { pk_level = 1; pk_l1node = node; }
    pk_l1_left = 0;
    c->x[0] = A->call_original(c); dl_grow(); listup_on = 1;
    uint64_t L = ui_data_list();
    if (L) { int back = (pk_level == 1 && pk_folder >= 0) ? pk_folder : 0; I32(L + 0x428) = back; }
    dl_filter_c(c, "enter");
}
static void on_listup_update(MkwCpu *c) { c->x[0] = A->call_original(c); if (listup_on) dl_filter_c(c, "update"); }
static void on_listup_leave(MkwCpu *c) {
    uint64_t L = ui_data_list();
    if (pk_level == 1 && L) { int f = folder_of(I32(L + 0x68)); if (f >= 0) pk_folder = f; }
    pk_l1_left = (pk_level == 1);
    pk_lastleave = c->x[0]; pk_leave_t = GetTickCount64();
    listup_on = 0; c->x[0] = A->call_original(c);
    normal_label_set(c, 0);
}

// ---- the map (VSStageSelect, VS and Time Trials). Its AINB has a 5th exit "List" (plug 4) into the track list.
// Setting open_mode: "list" (default) leaves the map for the list as soon as it is up; "map" keeps the map and + opens the list.
// Leaving it ourselves: close its pages (56 map, 69 CourseSelectBG) as its own exits do, then main+0x2d17c0(node, plug).
static ULONGLONG map_first, map_last; static int map_done, list_mode = 1;
static int read_list_mode(void) { char v[16]; if (A->size > offsetof(MkwPluginApi, setting_get) && A->setting_get && A->setting_get("open_mode", v, sizeof v)) return strcmp(v, "map") != 0; return 1; }
static void map_leave(MkwCpu *c, uint64_t node, int plug, const char *why) {
    uint64_t n8 = U64(node + 8), ui = n8 ? U64(n8 + 8) : 0; ui = ui ? U64(ui + 0x1c8) : 0;
    static uint32_t ev; static int32_t pg, vw;
    if (ui) for (int k = 0; k < 2; k++) {
        ev = EV_PAGE_OUT; pg = k ? 69 : 56; vw = -1;
        A->call(c, base_main + OFF_SEND_EVENT, 4, ui, (uint64_t)(uintptr_t)&ev, (uint64_t)(uintptr_t)&pg, (uint64_t)(uintptr_t)&vw);
    }
    A->call(c, base_main + 0x2d17c0ull, 2, node, (uint64_t)plug);
    A->log("custom courses: map: left through plug %d (%s)", plug, why);
}
static int map_hook(MkwCpu *c) {
    ULONGLONG t = GetTickCount64();
    if (t - map_last > 250) { map_first = t; map_done = 0; list_mode = read_list_mode(); }
    map_last = t;
    uint64_t node = c->x[0]; int plug = -1; const char *why = "";
    if (native_req) { native_req = 0; plug = 4; why = "+"; }
    else if (!map_done && list_mode && t - map_first > 300) {
        // (B on the list's first screen goes straight to the menu before the map: the AINB wires it so)
        plug = 4; why = "straight to the list";
    }
    if (plug < 0) return 0;
    map_done = 1;
    uint64_t save[9]; memcpy(save, c->x, sizeof save);
    c->x[0] = A->call_original(c); uint64_t r0 = c->x[0];
    map_leave(c, node, plug, why);
    memcpy(c->x, save, sizeof save); c->x[0] = r0;
    return 1;
}
static void options_page(const MkwPage *p) {
    static const char *const vals[] = { "list", "map" };
    static const char *const labels[] = { "Straight away (skip the map)", "Press + on the map" };
    p->heading("Track list");
    p->choice("open_mode", "Open the track list", vals, labels, 2);
    p->note(MKW_NOTE_DIM, "VS and Time Trials. Pick a location, then one of its routes or connectors (no connectors in Time Trials).");
}
MKW_PLUGIN_EXPORT void mkw_mod_page(const MkwPage *p) { options_page(p); }
static void on_tt_mark(MkwCpu *c) { if (!pk_tt) A->log("custom courses: picker: Time Trials"); pk_tt = 1; c->x[0] = A->call_original(c); }
static void on_vs_mark(MkwCpu *c) { if (pk_tt) A->log("custom courses: picker: VS"); pk_tt = 0; c->x[0] = A->call_original(c); }
static void on_bpage_reset(MkwCpu *c) { if (listup_on) dl_filter_c(c, "page"); cap_bpage(c); }
static void grow_list(uint64_t page) {
    uint64_t l = page + LIST_OFF;
    int32_t cap = *(int32_t *)mkw_guest_ptr(l + 0x18); uint64_t items = *(uint64_t *)mkw_guest_ptr(l + 0x20);
    uint64_t used = *(uint64_t *)mkw_guest_ptr(l + 0x30);
    if (cap >= BIG_CAP || !items || cap <= 0) return;
    memcpy(big_items, mkw_guest_ptr(items), (size_t)cap * 0x50);
    for (int i = cap; i < BIG_CAP; i++) memcpy(big_items + i * 0x50, mkw_guest_ptr(items), 0x50);   // fresh copies of an empty item
    for (int i = cap; i < BIG_CAP; i++) { memset(big_items + i * 0x50 + 0x18, 0, 8); big_items[i * 0x50 + 0x20] = 0; big_items[i * 0x50 + 0x21] = 0; }
    *(uint64_t *)mkw_guest_ptr(l + 0x20) = (uint64_t)(uintptr_t)big_items;
    if (used == items) *(uint64_t *)mkw_guest_ptr(l + 0x30) = (uint64_t)(uintptr_t)big_items;
    *(int32_t *)mkw_guest_ptr(l + 0x18) = BIG_CAP;
    A->log("custom courses: picker list grown from %d to %d items (in use: %s)", cap, BIG_CAP, used == items ? "moved" : used ? "elsewhere" : "not yet");
}
static void cap_bpage(MkwCpu *c) {
    if (c->x[0] && c->x[0] != bpage) { bpage = c->x[0]; have_last = 0; A->log("custom courses: probe: battle picker page 0x%llx", (unsigned long long)bpage); }
    if (bpage == c->x[0]) grow_list(bpage);
    c->x[0] = A->call_original(c);
}
// ---- cursor fixes for the picker. L+0x428 = remembered item index (set by the focus handler 24a6da0 from
// 250e970(list, button), which gives -1 for a button that holds no item). Slot 50 (24a6740) refocuses page+0x1170[L+0x428].
static int in_refocus;
static int item_of_button(uint64_t list, uint64_t btn) {
    int n = I32(list + 0x28); uint64_t it = U64(list + 0x30);
    for (int i = 0; i < n && it; i++) if (U64(it + 0x50ull * i + 0x18) == btn) return i;
    return -1;
}
static void on_picker_focus(MkwCpu *c) {
    uint64_t page = U64(c->x[0] + 8), ev = c->x[1];
    uint64_t L = ui_data_list();
    int type = (int)I32(ev + 8); uint64_t btn = U64(ev);
    int old = L ? I32(L + 0x428) : -2;
    int idx = (type == 0 && page) ? item_of_button(page + LIST_OFF, btn) : -3;
    c->x[0] = A->call_original(c);
    if (!page || !L || type != 0 || in_refocus) return;
    uint64_t list = page + LIST_OFF;
    A->log("custom courses: focus: button 0x%llx -> item %d (was %d, now %d), count %d, data %d, scroll %d, mode %d",
        (unsigned long long)btn, idx, old, I32(L + 0x428), I32(list + 0x28), I32(L + 0x88), I32(list + 0xb8), *(uint8_t *)mkw_guest_ptr(page + 0x13f8));
    if (idx >= 0 || old < 0 || old >= I32(list + 0x28)) return;
    // the cursor landed on a button with no track behind it: put it back on the last good track
    I32(L + 0x428) = old;
    uint64_t back = U64(U64(list + 0x30) + 0x50ull * old + 0x18);
    if (!back) { A->log("custom courses: focus: item %d has no button to go back to", old); return; }
    in_refocus = 1;
    A->call(c, base_main + 0x7fc700, 2, page + 0x7b8, 1ull);
    A->call(c, base_main + 0x7fb6c0, 5, page + 0x7b8, back + 0x1b8, 0ull, 0ull, 0ull);
    in_refocus = 0;
    A->log("custom courses: focus: moved back to item %d", old);
}
static void on_picker_restore(MkwCpu *c) {
    uint64_t page = c->x[0], L = ui_data_list(); int item = -1;
    if (page && L) {
        uint64_t list = page + LIST_OFF; int i = I32(L + 0x428), n = I32(list + 0x28), nb = I32(page + 0x1168);
        if (i < 0 || i >= n) i = 0;
        // bring the item on screen (scrollTo(list, index, now, clamp)), then find which of the page's buttons shows it
        uint64_t s[9]; memcpy(s, c->x, sizeof s);
        A->call(c, base_main + 0x673d00, 4, list, (uint64_t)i, 1ull, 1ull);
        memcpy(c->x, s, sizeof s);
        uint64_t btn = U64(U64(list + 0x30) + 0x50ull * i + 0x18), arr = U64(page + 0x1170); int j = -1;
        for (int k = 0; btn && arr && k < nb; k++) if (U64(arr + 8ull * k) == btn) { j = k; break; }
        if (j < 0) { A->log("custom courses: restore: item %d has no button, using 0", i); j = 0; i = 0; }
        I32(L + 0x428) = j; item = i;
    }
    cap_bpage(c);
    if (item >= 0) I32(L + 0x428) = item;
}

static void probe_tick(void) { return;
    uint64_t p = bpage; if (!p) return;
    const uint32_t *w = (const uint32_t *)mkw_guest_ptr(p + 0xbe0);
    char line[1024]; int n = 0, changed = 0;
    for (int i = 0; i < 96; i++) {
        uint32_t v = w[i];
        if (have_last && v != lastw[i] && v < 0x10000 && lastw[i] < 0x10000) { n += snprintf(line + n, sizeof line - n, " +%02x:%u->%u", i * 4, lastw[i], v); changed = 1; }
        lastw[i] = v;
    }
    if (!have_last) { n = 0; for (int i = 0; i < 64; i++) if (w[i] < 0x10000) n += snprintf(line + n, sizeof line - n, " +%02x=%u", i * 4, w[i]); A->log("custom courses: probe: list start:%s", line); have_last = 1; return; }
    if (changed) A->log("custom courses: probe: list%s", line);
}

// Picker: no moving off either end of the list (track lists have 2 tracks per column).
static void picker_edges(MkwPad *p) {
    uint64_t L = dl_list, page = bpage; if (!listup_on || !L || !page) return;
    int n = I32(page + LIST_OFF + 0x28), per = I32(page + LIST_OFF + 0xc8), i = I32(L + 0x428);
    if (n <= 0 || per <= 0 || i < 0 || i >= n) return;
    int col = i / per, last = (n - 1) / per;
    if (col == last) { p->buttons &= ~(1ull << MKW_PAD_RIGHT); if (p->lx > 0) p->lx = 0; if (p->rx > 0) p->rx = 0; }
    if (col == 0)    { p->buttons &= ~(1ull << MKW_PAD_LEFT);  if (p->lx < 0) p->lx = 0; if (p->rx < 0) p->rx = 0; }
}

static uint64_t prev; static int stick;
static void close_menu(void) { open_ = 0; A->overlay_show(draw, 0); }
static void filter(MkwPad *p, void *user) {
    (void)user;
    if (p->player != 0) { if (open_) { p->buttons = 0; p->lx = p->ly = p->rx = p->ry = 0; } return; }
    probe_tick();
    picker_edges(p);
    uint64_t b = p->buttons, down = b & ~prev; prev = b;
#define PRESSED(k) (down & (1ull << (k)))
    if (pressB_to) { ULONGLONG t = GetTickCount64(); if (t >= pressB_from && t < pressB_to) { p->buttons |= 1ull << MKW_PAD_B; return; } if (t >= pressB_to) pressB_to = 0; }
    if (native_on && !on_map() && GetTickCount64() - course_seen < 250 && !open_ && (b & ~prevp & (1ull << MKW_PAD_PLUS))) {
        prevp = b; want_page = ((want_page >= 0 ? want_page : native_page) + 1) % (native_pages ? native_pages : 1);
        char m[96]; snprintf(m, sizeof m, "Page %d next: press B, then open any track", want_page + 1); A->notice(m, 4);
        p->buttons &= ~(1ull << MKW_PAD_PLUS); return;
    }
    prevp = b;
    if (press_to2) { ULONGLONG t = GetTickCount64(); if (t >= press_from2 && t < press_to2) { p->buttons |= 1ull << MKW_PAD_A; return; } if (t >= press_to2) press_to2 = 0; }
    if (!open_ && press_to) { ULONGLONG t = GetTickCount64(); if (t >= press_from && t < press_to) { p->buttons |= 1ull << MKW_PAD_A; return; } if (t >= press_to) press_to = 0; }
    if (!open_) {
        if (PRESSED(MKW_PAD_PLUS) && on_map()) { want = 0; cur_f = cur_c = -1; native_req = 1; p->buttons &= ~(1ull << MKW_PAD_PLUS); }
        return;
    }
    int dir = 0, n = rows();
    if (PRESSED(MKW_PAD_UP)) dir = -1;
    if (PRESSED(MKW_PAD_DOWN)) dir = 1;
    if (p->ly > 20000 || p->ly < -20000) { if (!stick) dir = p->ly > 0 ? -1 : 1; stick = 1; } else stick = 0;
    if (dir && n) { if (level == 0) fsel = (fsel + dir + n) % n; else csel = (csel + dir + n) % n; }
    if (PRESSED(MKW_PAD_PLUS)) close_menu();
    else if (PRESSED(MKW_PAD_B)) { if (level) level = 0; else close_menu(); }
    else if (PRESSED(MKW_PAD_A)) {
        if (level == 0) {
            if (fsel == nf) { cur_f = cur_c = -1; apply(0); close_menu(); }
            else if (F[fsel].n) { level = 1; csel = (fsel == cur_f && cur_c >= 0) ? cur_c : 0; }
        } else {
            cur_f = fsel; cur_c = csel;
            A->log("custom courses: picked %s / %s (%s = %u)", F[fsel].name, F[fsel].c[csel].name, F[fsel].c[csel].course, F[fsel].c[csel].hash);
            apply(F[fsel].c[csel].hash); close_menu();
        }
    }
    p->buttons = 0; p->lx = p->ly = p->rx = p->ry = 0;   // the menu has the pad while it's open
}

static void loaded(void *u) {
    (void)u;
    base_main = A->module_base("main");
    int ok = A->override_address(base_main + OFF_REQPLAY_FN, on_request_play) + A->override_address(base_main + OFF_PRELOAD_FN, on_preload_course)
           + A->override_address(base_main + OFF_STAGESEL_UPDATE, on_stage_update) + A->override_address(base_main + OFF_COURSESEL_UPDATE, on_course_update);
    const uint64_t bslots[] = { 0x24a6a80, 0x24a6c80, 0x24a6b80, 0x24a6c50, 0x24a6480 };
    ok += A->override_address(base_main + 0x24a6820, on_bpage_reset) + A->override_address(base_main + 0x24a6740, on_picker_restore) + A->override_address(base_main + 0x24a79d0, on_picker_focus) + A->override_address(base_main + 0x24a7ab0, on_picker_focus);
    for (int i = 0; i < 5; i++) ok += A->override_address(base_main + bslots[i], cap_bpage);
    ok += A->override_address(base_main + 0x1c958d0, on_listup_enter) + A->override_address(base_main + 0x1c967f0, on_listup_leave) + A->override_address(base_main + 0x1c959f0, on_listup_update) + A->override_address(base_main + 0x24a6500, on_bpage_reset);
    ok += A->override_address(base_main + 0x1cffc10, on_tt_mark) + A->override_address(base_main + 0x1cc12e0, on_tt_mark) + A->override_address(base_main + 0x1cdd8d0, on_vs_mark) + A->override_address(base_main + 0x1cfc370, on_vs_mark);
    A->log("custom courses: main at 0x%llx, hooks installed: %d", (unsigned long long)base_main, ok);
}

MKW_PLUGIN_EXPORT int mkw_plugin_init(const MkwPluginApi *api, uint32_t api_version, const char **message) {
    A = api;
    if (api_version < 4 || api->size < offsetof(MkwPluginApi, quit) + sizeof(void *)) { *message = "Custom Courses needs mkw-recomp 0.1.17 or newer (plugin API 4)"; return 1; }
    if (strcmp(api->game_version, "1.8.0")) { *message = "Custom Courses only knows game 1.8.0 so far"; return 1; }
    load_list();
    if (api->size > offsetof(MkwPluginApi, settings_tab) && api->settings_tab) api->settings_tab("Track list", options_page);
    api->on_game_loaded(loaded, NULL);
    if (!api->overlay_set(draw, NULL) || !api->input_filter(filter, NULL)) { *message = "Custom Courses: the overlay or the pad filter was refused"; return 1; }
    api->log("custom courses: loaded on %s, game %s", api->port_version, api->game_version);
    return 0;
}
