/* This is a simple worker that receives a message from its parent thread, perform the
computation described by this message, and then post the result of that
computation back to the parent thread */
onmessage = function (message) {
	/* First, we unpack the message received:
		- tile: object with width and height property. It specifies the size of the rectangle
		of pixels for which we will be computing Mandelbrot set membership
		- (x0, y0): Point in the complex plane that corresponds to the upper-left
		pixel in the tile
		- perPixel: Pixel size in both the real and imaginary dimensions
		- maxIterations: Maximum number of iterations we will perform before deciding
		that a pixel is in the set
	*/
	const { tile, x0, y0, perPixel, maxIterations } = message.data
	const { width, height } = tile

	/* Next, we create an ImageData object to represent the rectangular array of pixels,
	get its internall ArrayBuffer, and create a typed array view of that buffer, so we can treat
	each pixel as a single integer, instead of 4 individual bytes. We will store the number
	of iteration for each pixel in this iteration array. (The iteration will be transform into 
	 actual pixel color in the parent thread) */
	const imageData = new ImageData(width, height)
	const iterations = new Uint32Array(imageData.data.buffer)

	/* Begin the computation.
	There are three nested for loops here.
	The outer 2 loops other the lines and columns of pixels, and the inner loop iterates each
	pixel to see if it escapes or not.
	
		-row, column: Integer representing the pixel coordinate 
		-x, y: Represent the complex point for each pixel: (x + yi)
		-index: The index in the iterations array for the current pixel
		-n: Track the number of iterations for each pixel
		-max, min: Track the largest and smallest number of iterations
		we've seen so far for any piexel in the rectangle
	*/
	let index = 0, max = 0, min = maxIterations
	for (let row = 0, y = y0; row < height; row++, y += perPixel) {
		for (let column = 0, x = x0; column < width; column++, x += perPixel) {
			/* For each pixel, we start with the complex number c = x + yi
			Then we repeatly compute the complex number z(n+1) based on this
			recursive formula:
				z(0) = c
				z(n+1) = z(n)^2 + c
			If |z(n)| (the magnitude of z(n)) is > 2, then the pixel not part of the set and 
			we stop after the n iterations
			*/
			let n            // The number of iteration so far
			let r = x, i = y // Starts with z(0) set to c
			for (n = 0; n < maxIterations; n++) {
				let rr = r * r, ii = i * i	// Square of two part of z(n)
				if (rr + ii > 4) break; // if |z(n)|^2 > 4, then we've escaped and can stop iterating
				i = 2 * r * i + y	// Compute imaginary part of z(n+1)
				r = rr - ii + x 	// 			real part of z(n+1)
			}
			iterations[index++] = n	// Remember # iterations for each pixels
			if (n > max) max = n		// Track the maximum number we've seen
			if (n < min) min = n		// And the minimum as well
		}
	}

	/* When the computation is complete, send the results back to the parent thread.
	The imageData object will be copied, but the giant ArrayBuffer, it contains will be transfered
	for a nice performance boost */
	this.postMessage({tile, imageData, min, max}, [imageData.data.buffer])
}

