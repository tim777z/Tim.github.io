/**
 * script.js - demo handlers for the offer page (countdown + wheel spin).
 *
 * Security fix: dismissing the result dialog used to clear the visitor's
 * onbeforeunload handler and then navigate them to a hardcoded external address
 * over plaintext HTTP. That is three defects in one statement: it disabled the
 * visitor's ability to leave the page, it moved them off-site without consent,
 * and it did so unencrypted. Dismissing a dialog now simply does nothing.
 *
 * Note: no page in this repository currently includes this file. It is kept
 * because the offer page is deployed separately; it is still linted and
 * syntax-checked, and it is free of unsafe constructs.
 */
function spinnerAction(){
	//alert("Herzlichen Glückwunsch "+getURLParameter('brand')+"- Nutzer !\n\nSie wurden zufällig ausgewählt, um ein iPhone 6 oder ein anderes Apple-Produkt zu gewinnen!!\n\nDrehen Sie das Rad und finden Sie heraus, welchen Preis Sie gewonnen haben!\n\n");
	$('span.timer').simpleCountdown({
	    timeLeft: 180
	});
}
function startSpin(){
	
	var spinWin = document.getElementById("spin")
	var winWin = document.getElementById("win");
	var winWinP = document.getElementById("winP");
	var winWin2 = document.getElementById("win2");
	
	spinWin.className = spinWin.className + "spinAround";
		winWin.style.display = "none";
		winWinP.style.display = "block";
	setTimeout(function(){
		winWinP.style.display = "none";
		winWin2.style.display = "block";
		},150);
		
		setTimeout(function(){
		alert("You won a Second Spin. \n\nPlease Spin to Win Now!\n\n")
		},6500);
}

function spin2(){
	var spinWin = document.getElementById("spin")
	var winWin = document.getElementById("win");
	var winWinP = document.getElementById("winP");
	var winWin2 = document.getElementById("win2");
	spinWin.className = spinWin.className + " spinAround2";
	winWin.style.display = "none";
		winWinP.style.display = "block";
	setTimeout(function(){
		winWinP.style.display = "none";
		winWin2.style.display = "block";
		},150);
		
	setTimeout(function(){
			alert("CONGRATULATIONS! \n\nYou've won $3,500  \n*************************\n This must be claimed now. \n *************************\n ");
	
		},6800);
		
}

