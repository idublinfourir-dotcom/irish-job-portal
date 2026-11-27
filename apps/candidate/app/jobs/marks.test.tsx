// Unit (Stage 3 step 6): on a cached page the save mark comes from the candidate's saved list (SavedMarks, filled in the browser by SavedMarksFromApi);
// the server HTML has no mark and no request, and both sign-in variants sit under the hint switch.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SaveButton, SavedMarks, SavedMarksFromApi } from "./client";
import { BySignIn } from "./parts";
import { OccupationTile } from "../occupations/tile";
import { NOW, card } from "./test-fixtures";

describe("saved marks on a cached page", () => {
  it("marks a saved job from the list, leaves the others, and the server render (no list yet) marks nothing", () => {
    const two = html(<SavedMarks.Provider value={new Set(["7"])}><SaveButton jobId="7" title="A" saved={false} /><SaveButton jobId="8" title="B" saved={false} /></SavedMarks.Provider>);
    expect(two.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(two).toContain("Saved: A. Remove it");
    expect(html(<SavedMarksFromApi><SaveButton jobId="7" title="A" saved={false} /></SavedMarksFromApi>)).toContain('aria-pressed="false"');
  });
  it("BySignIn sends both variants under the switch when the server does not know, one when it does", () => {
    expect(html(<BySignIn signedIn={undefined} yes="in" no="out" />)).toBe('<span data-in-only="" class="contents">in</span><span data-out-only="" class="contents">out</span>');
    expect(html(<BySignIn signedIn yes="in" no="out" />)).toBe("in");
    expect(html(<BySignIn signedIn={false} yes="in" no="out" />)).toBe("out");
    const tile = html(<OccupationTile job={card()} now={NOW} signedIn={undefined} saved={false} path="/occupations/x" />);
    expect(tile).toMatch(/data-in-only[^>]*><span[^>]*><button[^>]*aria-pressed="false"/);
    expect(tile).toMatch(/data-out-only[^>]*><a [^>]*href="\/login/);
  });
});
