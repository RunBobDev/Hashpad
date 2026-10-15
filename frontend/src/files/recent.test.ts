import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClearRecent, ForgetRecent, RememberOpened } from '../../wailsjs/go/app/App';
import { clearRecent, forgetRecent, recentFiles, rememberOpened, setRecentFiles } from './recent';

vi.mock('../../wailsjs/go/app/App', () => ({
  RememberOpened: vi.fn(),
  ForgetRecent: vi.fn(),
  ClearRecent: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  setRecentFiles(['C:\\old.md']);
});

describe('the recent list', () => {
  it('takes the list Go answers with, Go being its owner', async () => {
    vi.mocked(RememberOpened).mockResolvedValue(['C:\\new.md', 'C:\\old.md']);
    await rememberOpened('C:\\new.md');
    expect(RememberOpened).toHaveBeenCalledWith('C:\\new.md');
    expect(recentFiles()).toEqual(['C:\\new.md', 'C:\\old.md']);
  });

  it('keeps what it had when Go cannot write', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(RememberOpened).mockRejectedValue('disk full');
    await rememberOpened('C:\\new.md');
    expect(recentFiles()).toEqual(['C:\\old.md']);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('forgets one file, and clears them all', async () => {
    vi.mocked(ForgetRecent).mockResolvedValue([]);
    await forgetRecent('C:\\old.md');
    expect(ForgetRecent).toHaveBeenCalledWith('C:\\old.md');
    expect(recentFiles()).toEqual([]);

    setRecentFiles(['C:\\a.md']);
    vi.mocked(ClearRecent).mockResolvedValue([]);
    await clearRecent();
    expect(recentFiles()).toEqual([]);
  });

  it('treats a missing list from an older settings file as empty', () => {
    setRecentFiles(null);
    expect(recentFiles()).toEqual([]);
  });
});
