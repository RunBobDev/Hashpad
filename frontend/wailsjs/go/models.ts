export namespace app {
	
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

}

