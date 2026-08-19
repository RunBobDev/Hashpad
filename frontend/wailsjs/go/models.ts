export namespace app {
	
	export class AppearanceSettings {
	    theme: string;
	    accentColor: string;
	    uiFontSize: number;
	
	    static createFrom(source: any = {}) {
	        return new AppearanceSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.accentColor = source["accentColor"];
	        this.uiFontSize = source["uiFontSize"];
	    }
	}
	export class EditorSettings {
	    fontFamily: string;
	    fontSize: number;
	    lineHeight: number;
	    wordWrap: boolean;
	    maxContentWidth: number;
	    showLineNumbers: boolean;
	    tabSize: number;
	    insertSpaces: boolean;
	    defaultViewMode: string;
	
	    static createFrom(source: any = {}) {
	        return new EditorSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.lineHeight = source["lineHeight"];
	        this.wordWrap = source["wordWrap"];
	        this.maxContentWidth = source["maxContentWidth"];
	        this.showLineNumbers = source["showLineNumbers"];
	        this.tabSize = source["tabSize"];
	        this.insertSpaces = source["insertSpaces"];
	        this.defaultViewMode = source["defaultViewMode"];
	    }
	}
	export class FileContents {
	    path: string;
	    content: string;
	    encoding: string;
	    lineEnding: string;
	    mixed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileContents(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.encoding = source["encoding"];
	        this.lineEnding = source["lineEnding"];
	        this.mixed = source["mixed"];
	    }
	}
	export class FilesSettings {
	    autosave: boolean;
	    autosaveDelayMs: number;
	    assetFolder: string;
	    defaultEncoding: string;
	
	    static createFrom(source: any = {}) {
	        return new FilesSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.autosave = source["autosave"];
	        this.autosaveDelayMs = source["autosaveDelayMs"];
	        this.assetFolder = source["assetFolder"];
	        this.defaultEncoding = source["defaultEncoding"];
	    }
	}
	export class PreviewSettings {
	    fontFamily: string;
	    fontSize: number;
	    syncScroll: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PreviewSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.syncScroll = source["syncScroll"];
	    }
	}
	export class ToolbarSettings {
	    visible: boolean;
	    pinned: string[];
	
	    static createFrom(source: any = {}) {
	        return new ToolbarSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.visible = source["visible"];
	        this.pinned = source["pinned"];
	    }
	}
	export class WindowSettings {
	    width: number;
	    height: number;
	    maximized: boolean;
	    outlineVisible: boolean;
	    outlineWidth: number;
	    statusBarVisible: boolean;
	    previewSplitRatio: number;
	
	    static createFrom(source: any = {}) {
	        return new WindowSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.width = source["width"];
	        this.height = source["height"];
	        this.maximized = source["maximized"];
	        this.outlineVisible = source["outlineVisible"];
	        this.outlineWidth = source["outlineWidth"];
	        this.statusBarVisible = source["statusBarVisible"];
	        this.previewSplitRatio = source["previewSplitRatio"];
	    }
	}
	export class Settings {
	    version: number;
	    appearance: AppearanceSettings;
	    editor: EditorSettings;
	    preview: PreviewSettings;
	    files: FilesSettings;
	    window: WindowSettings;
	    toolbar: ToolbarSettings;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.appearance = this.convertValues(source["appearance"], AppearanceSettings);
	        this.editor = this.convertValues(source["editor"], EditorSettings);
	        this.preview = this.convertValues(source["preview"], PreviewSettings);
	        this.files = this.convertValues(source["files"], FilesSettings);
	        this.window = this.convertValues(source["window"], WindowSettings);
	        this.toolbar = this.convertValues(source["toolbar"], ToolbarSettings);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	

}

