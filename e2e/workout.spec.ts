import { expect, test } from '@playwright/test';

// One full pass through setryx the way someone uses it in the gym:
// first-run setup, a workout with a timed exercise, a rest and a reps set,
// the info sheet pausing the timer, the review with a corrected set, saving,
// and the result in Stats and in the workout's targets.

test('a full workout: setup, play, review, save, stats', async ({ page }) => {
  // ── First run: create the admin ──
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Your name').fill('Test Lifter');
  await page.getByLabel('Username').fill('lifter');
  await page.getByLabel('Password', { exact: true }).fill('a long test password');
  await page.getByLabel('Type it again').fill('a long test password');
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  // ── A workout: 15 s plank, 5 s rest, bench press 10 × 8 kg ──
  const step = (over: object) => ({ kind: 'exercise', id: crypto.randomUUID(), tempo: null, rir: null, notes: null, equipmentNote: null, ...over });
  const created = await page.request.post('/api/v1/workouts', {
    headers: { origin: new URL(page.url()).origin },
    data: {
      name: 'E2E Session',
      icon: '',
      items: [
        step({ exerciseId: 'lib:Plank', targetType: 'timed', targetReps: null, targetDurationS: 15, targetWeight: null }),
        { kind: 'rest', id: crypto.randomUUID(), durationS: 5, label: null },
        step({ exerciseId: 'lib:Dumbbell_Bench_Press', targetType: 'reps', targetReps: 10, targetDurationS: null, targetWeight: 8 }),
      ],
    },
  });
  expect(created.status()).toBe(201);
  const workoutId = (await created.json()).workout.id as string;

  // ── Start it from Today ──
  await page.reload();
  await page.getByRole('link', { name: 'Start E2E Session' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Session' })).toBeVisible();
  await page.getByRole('button', { name: 'Start workout' }).click();
  await expect(page.locator('.ex-name')).toHaveText('Plank');
  const big = page.locator('.big');
  await expect(big).toHaveText(/^1\ds$/, { timeout: 8_000 }); // past the 3-2-1, counting down from 15

  // ── The info sheet pauses a timed exercise ──
  await page.getByRole('button', { name: 'Exercise details' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Paused while you read')).toBeVisible();
  const heldAt = await big.textContent();
  await page.waitForTimeout(2_500);
  expect(await big.textContent()).toBe(heldAt);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();

  // ── The plank runs out by itself, skip the rest, log the bench press ──
  await expect(big).not.toHaveText(heldAt!, { timeout: 8_000 }); // resumed after the countdown
  // Ending the plank early would count as a shorter hold (and suggest a new target), so let it finish.
  await expect(page.locator('.ex-name')).toHaveText('Rest', { timeout: 25_000 });
  // The control bar's Next button (the tap area has the same name).
  const next = page.locator('.controls .ctrl-next');
  await expect(next).toHaveAccessibleName('Skip rest');
  await next.click();
  await expect(page.locator('.ex-name')).toHaveText('Dumbbell Bench Press');
  await next.click();

  // ── Review: did 9, not 10. The update prompt ticks itself. ──
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByRole('heading', { name: 'E2E Session done' })).toBeVisible();
  const bench = page.locator('.review-group').filter({ hasText: 'Dumbbell Bench Press' });
  await bench.getByRole('button', { name: 'Less reps' }).click();
  await expect(bench.getByRole('checkbox')).toBeChecked();
  await expect(bench).toContainText('Update the workout to 9 reps at 8 kg next time');
  await page.getByRole('button', { name: 'Save session and update 1 target' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  // ── It's in Stats, and the workout learned the new target ──
  await page.getByRole('link', { name: 'Stats' }).click();
  await expect(page.getByRole('heading', { name: 'Recent sessions' })).toBeVisible();
  await expect(page.locator('.panel').filter({ hasText: 'Recent sessions' })).toContainText('E2E Session');
  await expect(page.locator('.panel').filter({ hasText: 'Exercises' })).toContainText('Dumbbell Bench Press');

  await expect
    .poll(async () => {
      const w = (await (await page.request.get(`/api/v1/workouts/${workoutId}`)).json()).workout;
      return w.items.find((i: { exerciseId?: string }) => i.exerciseId === 'lib:Dumbbell_Bench_Press')?.targetReps;
    })
    .toBe(9);
});
