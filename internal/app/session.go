package app

// Checkpoint O (design §4.35): what was open, for reopening it at start, and
// the recent files for File > Open Recent. Paths only -- nothing here ever
// writes a document's contents (owner's condition).

const maxRecentFiles = 10

// updateSession is the only writer of Settings.Session. It reads the file,
// lets change edit the session section alone, and writes it back, all under
// settingsMu.
func updateSession(change func(*SessionState)) (SessionState, error) {
	path, err := SettingsPath()
	if err != nil {
		return SessionState{}, err
	}
	settingsMu.Lock()
	defer settingsMu.Unlock()
	// Never fails: a bad file comes back as defaults, backed up, as at start.
	s, _ := LoadSettingsFrom(path)
	change(&s.Session)
	return s.Session, SaveSettingsTo(path, s)
}

// RememberOpened puts path at the top of the recent list and returns the list.
func (a *App) RememberOpened(path string) ([]string, error) {
	s, err := updateSession(func(s *SessionState) { s.RecentFiles = withRecent(s.RecentFiles, path) })
	return s.RecentFiles, err
}

// ForgetRecent drops a file that has gone from the recent list.
func (a *App) ForgetRecent(path string) ([]string, error) {
	s, err := updateSession(func(s *SessionState) { s.RecentFiles = without(s.RecentFiles, path) })
	return s.RecentFiles, err
}

// ClearRecent empties the recent list (Clear Recently Opened).
func (a *App) ClearRecent() ([]string, error) {
	s, err := updateSession(func(s *SessionState) { s.RecentFiles = []string{} })
	return s.RecentFiles, err
}

// RememberTabs records the open files in tab order and which one is active;
// an index naming no tab means an unsaved document is active.
func (a *App) RememberTabs(paths []string, active int) error {
	if paths == nil {
		paths = []string{}
	}
	if active < 0 || active >= len(paths) {
		active = -1
	}
	_, err := updateSession(func(s *SessionState) {
		s.OpenTabs = paths
		s.ActiveTab = active
	})
	return err
}

// withRecent puts path first and keeps the rest in order without it, cut to
// maxRecentFiles. Exact match, the rule one-tab-per-file uses (documentops.ts).
func withRecent(list []string, path string) []string {
	out := []string{path}
	for _, p := range list {
		if len(out) == maxRecentFiles {
			break
		}
		if p != path {
			out = append(out, p)
		}
	}
	return out
}

func without(list []string, path string) []string {
	out := []string{}
	for _, p := range list {
		if p != path {
			out = append(out, p)
		}
	}
	return out
}
