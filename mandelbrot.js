/* 
    This class represent a subrectangle of a canvas or image. We use Tiles to divide 
    a canvas int regions that can be processed independently by Workers
*/
class Tile {
    constructor(x, y, width, height) {
        this.x = x
        this.y = y
        this.width = width
        this.height = height
    }

    /* This static method is a generator that divides a rectangle of the specified width and
    height into the specified number of rows and columns and yields numRows*numCols Tile object
    to cover the rectangle */
    static *tiles(width, height, numRows, numCols) {
        let columnWidth = Math.ceil(width / numCols), rowHeight = Math.ceil(height / numRows)
        for (let row = 0; row < numRows; row++) {
            let tileHeight = (row < numRows - 1) ? rowHeight : height - rowHeight * (numRows - 1)
            for (let col = 0; col < numCols; col++) {
                let tileWidth = (col < numCols - 1) ? columnWidth : width - columnWidth * (numCols - 1)
                yield new Tile(col * columnWidth, row * rowHeight, tileWidth, tileHeight)
            }
        }
    }
}

/* 
    This class represent a pool of worker, all running the same code. The worker code
    you specify must respond to each message it receives by performing some kind of computation,
    and posting a single message with the result of the computation


    Given a WorkerPool and message that represents work to be performed, simply call 
    addWork(), with the message as an argument. If there is a worker object that is currently
    iddle, the message will be posted to that worker immediately. If there are no idle worker,
    the message will queued and will be posted to a Worker when one becomes available
    addWork() return a promise, which will resolved with the message received from the work
    and will reject if the worker throws with an unhandled error
*/
class WorkerPool {
    constructor(numWorkers, workerSource) {
        this.idleWorkers = []   // Workers that are not currently working
        this.workQueue = []     // Work not currently being processed 
        this.workerMap = new Map() // Map workers to resolve and reject funcs

        // Create the specified number of workers, add message and error handlers
        // and save them in the idleWorkers array
        for (let i = 0; i < numWorkers; i++) {
            let worker = new Worker(workerSource)
            worker.onmessage = message => { this._workerDone(worker, null, message.data) }
            worker.onerror = error => { this._workerDone(worker, error, null) }
            this.idleWorkers[i] = worker
        }
    }

    // This internal method is called when a worker finishes working, either by sending a message
    // or by throwing an error
    _workerDone(worker, error, response) {
        let [resolver, rejector] = this.workerMap.get(worker)
        this.workerMap.delete(worker)
        // If there is no queued work, put this worker back in the list of idle workers.
        // Otherwise, take work from the queue and send it to this worker 
        if (this.workQueue.length === 0) this.idleWorkers.push(worker)
        else {
            let [work, resolver, rejector] = this.workQueue.shift()
            this.workerMap.set(worker, [resolver, rejector])
            worker.postMessage(work)
        }

        // Finally, resolve or reject the promise associated with the worker
        error === null ? resolver(response) : rejector(error)
    }

    /* This method add work to the worker pool and return a promise that will resolve with
    a worker's response when the work is done. The worker is a value to be past to a worker
    with postMessage(). If there is an idle worker, the work message will be sent immediately.
    Otherwise, it will be queued until a worker is available */
    addWork(work) {
        return new Promise((resolve, reject) => {
            if (this.idleWorkers.length > 0) {
                let worker = this.idleWorkers.pop()
                this.workerMap.set(worker, [resolve, reject])
                worker.postMessage(work)
            } else {
                this.workQueue.push([work, resolve, reject])
            }
        })
    }
}

/* This class hold the state information necessary to hundle a Mandlebrot set.
The cx and cy properties give the point in the complex plane, that is the center of the image.
The perPixel property specifies how much the real and immaginary parts of that complex numbers
changes for each Pixel of image.
The maxIteration property specify how hard we work to compute the set. Larger number require
more computation but produce crisper image.
Note that the size of the canvas is not part of the state. Given cx, cy and perPixel, we simply
render whatever portion of Mandelbrot set fits in the canvas at its current size

Object of this type are used with history.pushState() and are used to read the desired state from
a bookmarked or shared URL
*/
class PageState {
    // This factory method returns an initial state to display the entire set
    static initialState() {
        let s = new PageState()
        s.cx = -0.5
        s.cy = 0
        s.perPixel = 3 / window.innerHeight
        s.maxIterations = 500
        return s
    }

    // This factory method obtain state from url or return null if a valid state could not be
    // read from the URL
    static fromURL(url) {
        let s = new PageState(), u = new URL(url)
        s.cx = parseFloat(u.searchParams.get('cx'))
        s.cy = parseFloat(u.searchParams.get('cy'))
        s.perPixel = parseFloat(u.searchParams.get('pp'))
        s.maxIterations = parseInt(u.searchParams.get('it'))
        return (isNaN(s.cx) || isNaN(s.cy) || isNaN(s.perPixel) || isNaN(s.maxIterations)) ? null : s
    }

    // This instance method encodes the current states into the search parameters of the browser's
    // current location 
    toURL() {
        let u = new URL(location)
        u.searchParams.set('cx', this.cx)
        u.searchParams.set('cy', this.cy)
        u.searchParams.set('pp', this.perPixel)
        u.searchParams.set('it', this.maxIterations)
        return u.href
    }
}

// This constant control the parallelism of the Mandelbrot set computation
// You can adjust them to get performance to you computer
const ROWS = 3, COLS = 4, NUMWORKERS = navigator.hardwareConcurrency || 2


/* This is the main class of our Mandelbrot set. Simply invoke the constructor function with
the <canvas> element to render into. The program assumes that this canvas element is styled
so that it is always as big as the browser window */
class MandelbrotCanvas {
    constructor(canvas) {
        // Store the canvas, get its context obj, and initialize a WorkerPool
        this.canvas = canvas
        this.context = this.canvas.getContext('2d')
        this.workerPool = new WorkerPool(NUMWORKERS, 'mandelbrotWorker.js')

        // some properties that we'll use later
        this.tiles = null           // subregions of the canvas
        this.pendingRender = null   // we're not currently rendering
        this.wantsRender = false    // No render is currently requested
        this.resizeTimer = null     // Prevents as to resizing too frequently
        this.colorTable = null       // For converting row data to pixel values

        // set our event handlers 
        this.canvas.addEventListener('pointerdown', e => this.handlePointer(e))
        window.addEventListener('keydown', e => this.handleKey(e))
        window.addEventListener('resize', e => this.handleResize(e))
        window.addEventListener('popstate', e => this.setState(e.state, false))

        // initialize our state from the URL or start with the initial state 
        this.state = PageState.fromURL(location) || PageState.initialState()
        // save this state with the history mechanism
        history.replaceState(this.state, '', this.state.toURL())
        // set the canvas size and get an array of tiles that cover it 
        this.setSize()
        this.render()
    }

    // Set the canvas size and initialize an array of Tile objects. This method is called from 
    // the constructor and also by handleResize() method when the browser window is resized
    setSize() {
        this.width = this.canvas.width = window.innerWidth
        this.height = this.canvas.height = window.innerHeight
        this.tiles = [...Tile.tiles(this.width, this.height, ROWS, COLS)]
    }

    /* This function makes a change to PageState, then re-renders the Mendelbrot set using that
    new state, and also save the new state with history.push_state(). If the first argument is a
    function, that function will be called with state object as its argument. If the first argument
    is an object, then we will simply copy the properties of that object into the state object.
    If the optional second argument is false, then the new state will not be saved. We do this when
    calling setState() in response to a popstate event.
    */
    setState(f, save = true) {
        // If f argument is a function, call it to update the state.
        // Otherwise, copy its properties into the current state
        if (typeof f === 'function') f(this.state)
        else for (let property in f) this.state[property] = f[property]

        this.render()

        if (save) history.pushState(this.state, '', this.state.toURL())
    }

    /* This method asynchronously draws the portion of the Mandelbrot set specified by the 
    PageState object into the canvas. It is called by the contructor and setState() when
    the state changes, and by the resize event when the size of the canvas changes */
    render() {
        /* Sometimes, the user may use the keyboard or mouse to request render more quickly than
        we can perform them. We don't want to submit all the renders to the worker pool. Instead,
        if we're rendering, we'll just make a note that a new render is needed, and when the current
        render is completes we render the current state, possibly skipping multiple intermediate states */
        if (this.pendingRender) {    // If we are already rendering
            this.wantsRender = true
            return;
        }

        // Get out state variable and compute the complex number for the upper left corner of the canvas
        let { cx, cy, perPixel, maxIterations } = this.state,
            x0 = cx - perPixel * this.width/2,
            y0 = cy - perPixel * this.height/2

        // For each of our ROWS*COLS tiles, call addWork() with a message for the code in 
        // mandelbrot.js. Collect the resulting promise object into an array
        let promises = this.tiles.map(tile => this.workerPool.addWork({
            tile,
            perPixel,
            maxIterations,
            x0: x0 + tile.x * perPixel,
            y0: y0 + tile.y * perPixel
        }))

        // Use a Promise.all() to get an array of responses from the array of the promises.
        // Each response is the computation for one of our tiles. Recall from mandelbrot.js that
        // each response includes the Tile object, an imageData that includes the iteration count
        // instead of pixel values, and the maximum and minimum iterations for that tile
        this.pendingRender = Promise.all(promises).then(responses => {
            // First find the overall max and min iterations over all tiles.
            // We need this number so we can asing colors to the pixels 
            let min = maxIterations, max = 0
            for (let r of responses) {
                if (r.min < min) min = r.min
                if (r.max > max) max = r.max
            }

            // Now, we need a way to convert the raw iterations from the workers into pixels
            // color that will be displayed with the canvas. We know that all the pixels have
            // between min and max iterations so we precompute the color for each iterations count 
            // and store them in the colorTable array

            // If we haven't allocated a color table array yet, or if it is no longer the right size,
            // then allocated the new one.
            if (!this.colorTable || this.colorTable.length !== maxIterations + 1) {
                this.colorTable = new Uint32Array(maxIterations + 1)
            }

            /* Given the max and the min, compute apropriate values in the color table. Pixel in
            the set will be colored fully opaque black. Pixel outside the set will be translucent
            black with hight iteration counts resulting in the higher opacity. Pixel with min
            iteration counts will be transparent and the white background will show through,
            resulting in a grayscale image */
            if (min === max) {
                if (min === maxIterations) this.colorTable[min] = 0xff000000
                else this.colorTable[min] = 0
            } else {
                // In normal case, when min and max are different, use a logarithic scale to
                // asign its possible iteration count an opacity between 0 and 255, and then
                // use the shift left operator to turn that into a pixel value
                let maxLog = Math.log(1 + max - min)
                for (let i = min; i <= max; i++) this.colorTable[i] = Math.ceil(Math.log(1 + i - min) / maxLog * 255) << 24
            }

            // Now translate the iteration numbers in each response's ImageData to colors
            // from the color table.
            for (let r of responses) {
                let iterations = new Uint32Array(r.imageData.data.buffer)
                for (let i = 0; i < iterations.length; i++) iterations[i] = this.colorTable[iterations[i]]
            }

            // Finally, render all the imageData object into their corresponding tiles of the canvas
            // using putImageData()
            // First, though, removes any CSS transforms on the canvas that may have been set by the
            // pointer down event handler
            this.canvas.style.transform = ''
            for (let r of responses) this.context.putImageData(r.imageData, r.tile.x, r.tile.y)
        })
            .catch(reason => {
                // If anything went wrong in any of our promises, we'll log an error here.
                // This should not happen, but this will help with debbuging if it does
                console.error('Promise rejected in render():', reason)
            })
            .finally(() => {
                // When we are done rendering, clear the pendingRender flags
                this.pendingRender = null
                // And if a render request came in while we are busy, renderer now
                if (this.wantsRender) {
                    this.wantsRender = false
                    this.render()
                }
            })
    }

    /* If the user resize the window, this function will be called repeatedly
    Resizing the canvas and rendering the Mandelbrot set is an expensive opertion that we can't
    do multiple times of seconds, so we use a timer to differ handling the resize until 200ms 
    have elapsed since the last receive event was received 
    */
    handleResize(event) {
        // If we are already differing a resize, clear it.
        if(this.resizeTimer) clearTimeout(this.resizeTimer)
        // And defer this resize instead
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null
            this.setSize()
            this.render()
        }, 200)
    }

    /* If the user press a key, this event handler will called.
    We call setState() in response to various keys, and setState() renders the new state,
    update the url, and save the state of the browser in the history */
    handleKey(event) {
        switch(event.key) {
            case 'Escape':  // Type escape to go back to the inital scale
                this.setState(PageState.initialState())
                break;
            case '+':       // Type + to increase the number of iterations
                this.setState(s => {
                    s.maxIterations = Math.round(s.maxIterations*1.5)
                })
                break;
            case '-':       // Type - to decrease the number of iterations
                this.setState(s => {
                    s.maxIterations = Math.round(s.maxIterations/1.5)
                    if(s.maxIterations < 1) s.maxIterations = 1
                })
                break;
            case 'o':       // Type o to zoom out
                this.setState(s => s.perPixel *= 2)
                break;
            case 'ArrowUp': // Up arrow to scroll up
                this.setState(s => s.cy -= this.height/10 * s.perPixel)
                break;
            case 'ArrowDown':   // Scroll down
                this.setState(s => s.cy += this.height/10 * s.perPixel)
                break;
            case 'ArrowLeft':   // Scroll to the left
                this.setState(s => s.cx -= this.width/10 * s.perPixel)
                break;
            case 'ArrowRight':  // Scroll to the right
                this.setState(s => s.cx += this.width/10 * s.perPixel)
                break;
        }
    }

    /* This method is called when we get a pointerdown event on the canvas. The pointer down
    event may be the start of a zoom gesture (a click or tap) or a pan gesture (a drag).
    This handler registers handlers for the pointermove and pointerup events in order to respond
    to the reset of the gesture. These two extra handler are removed when the gesture ends with a 
    pointerup */
    handlePointer(event) {
        // The pixel coordinates and time of the initial pointer down
        // Because the canvas is as big as the window, this event coordinates are 
        // also canvas coordinates
        const x0 = event.clientX, y0 = event.clientY, t0 = Date.now()

        // This is the  handler for the movement
        const pointerMoveHandler = event => {
            // how much we have moved, and how much time was passed?
            let dx = event.clientX - x0,
                dy = event.clientY - y0,
                dt = Date.now() - t0

            // If the pointer has moved enough or enough time was elapsed that this is not a
            // regular click, then use CSS to pan the display
            // We will render it for a real when we get the pointerup event
            if(dx > 10 || dy > 10 || dt > 500) this.canvas.style.transform = `translate(${dx}px, ${dy}px)`
        }
        
        // This is the handler for pointerup event
        const pointerUpHandler = event => {
            // When the pointer goes up, the gesture is over, so remove the move and up
            // handlers until the next gesture
            this.canvas.removeEventListener('pointermove', pointerMoveHandler)
            this.canvas.removeEventListener('pointerup', pointerUpHandler)

            // How much did the pointer move and how much time passed
            const dx = event.clientX-x0, dy = event.clientY-y0, dt = Date.now() - t0
            // Unpack the state object individual constants
            const {cx, cy, perPixel} = this.state

            // If the pointer moved far enough or if enough time is passed, then this was a
            // pan gesture, and we need to change state to change the center point. Otherwise
            // the user clicked or tapped on a point and we need to center and zoom in on that point
            if (dx > 10 || dy > 10 || dt > 500) {
                // The user panned the image by (dx, dy) pixels
                // Convert those value to offset in the complex plane
                this.setState({cx: cx - dx *perPixel, cy: cy - dy * perPixel})
            } else {
                // The user clicked. Compute how many pixel the center moves.
                let cdx = x0 - this.width/2, cdy = y0 - this.height/2

                // Use CSS to quickly and temporarily zoom in
                this.canvas.style.transform = `translate(${-cdx*2}px, ${-cdy*2}px) scale(2)`

                // Set the complex coordinates of the new center point and zoom in by a factor of 2
                this.setState(s => {
                    s.cx += cdx * s.perPixel
                    s.cy += cdy * s.perPixel
                    s.perPixel /= 2
                })
            }
        }

        // When the user begins a gesture we register handlers for the pointer move 
        // and pointerup events that follow
        this.canvas.addEventListener('pointermove', pointerMoveHandler)
        this.canvas.addEventListener('pointerup', pointerUpHandler)
    }
}

let canvas = document.createElement('canvas')
document.body.prepend(canvas)
document.body.style = 'margin: 0'
canvas.style.width = '100%'
canvas.style.height = '100%'

new MandelbrotCanvas(canvas) // Start the rendering 

