Implementation Strategy
1. Contract Extension
Add POAP-based discount logic to Swag1155.sol:
solidity// Add to state variables
struct DiscountTier {
    uint256 eventId;      // POAP event ID
    uint256 discount;     // Discount in basis points (e.g., 1000 = 10%)
    bool active;
}

mapping(uint256 => DiscountTier[]) public tokenDiscounts; // tokenId => discount tiers
address public poapContract; // POAP contract address (0x22C1f6050E56d2876009903609a2cC3fEf83B415 on mainnet)

// Add discount functions
function addDiscount(
    uint256 tokenId,
    uint256 poapEventId,
    uint256 discountBps
) external onlyRole(ADMIN_ROLE) {
    require(discountBps < ROYALTY_DENOMINATOR, "discount too high");
    tokenDiscounts[tokenId].push(DiscountTier({
        eventId: poapEventId,
        discount: discountBps,
        active: true
    }));
    emit DiscountAdded(tokenId, poapEventId, discountBps);
}

function getDiscountedPrice(
    uint256 tokenId,
    address buyer
) public view returns (uint256) {
    Variant memory v = variants[tokenId];
    uint256 basePrice = v.price;
    
    // Check all discount tiers for this token
    DiscountTier[] storage discounts = tokenDiscounts[tokenId];
    for (uint256 i = 0; i < discounts.length; i++) {
        if (!discounts[i].active) continue;
        
        // Check if buyer holds POAP
        if (IPOAP(poapContract).balanceOf(buyer, discounts[i].eventId) > 0) {
            uint256 discount = (basePrice * discounts[i].discount) / ROYALTY_DENOMINATOR;
            return basePrice - discount;
        }
    }
    
    return basePrice; // No discount
}

// Update buy() to use discounted price
function buy(uint256 tokenId, uint256 quantity) external nonReentrant {
    require(quantity > 0, "invalid quantity");
    Variant storage v = variants[tokenId];
    require(v.active, "variant inactive");
    require(v.minted + quantity <= v.maxSupply, "exceeds supply");

    uint256 unitPrice = getDiscountedPrice(tokenId, msg.sender);
    uint256 total = unitPrice * quantity;
    _distributePayment(tokenId, total);

    v.minted += quantity;
    _mint(msg.sender, tokenId, quantity, "");

    emit Purchased(msg.sender, tokenId, quantity, unitPrice, total);
}
2. POAP Interface
solidity// Add interface for POAP
interface IPOAP {
    function balanceOf(address owner, uint256 eventId) external view returns (uint256);
}
3. Frontend Integration
typescript// Check if user qualifies for discount
async function getApplicableDiscount(tokenId: bigint, userAddress: string) {
  const discountedPrice = await readContract({
    address: SWAG1155_ADDRESS,
    abi: Swag1155ABI,
    functionName: 'getDiscountedPrice',
    args: [tokenId, userAddress],
  });

  const basePrice = await readContract({
    address: SWAG1155_ADDRESS,
    abi: Swag1155ABI,
    functionName: 'variants',
    args: [tokenId],
  }).then(v => v.price);

  const discountPercent = basePrice > discountedPrice 
    ? ((basePrice - discountedPrice) * 100n) / basePrice 
    : 0n;

  return {
    basePrice,
    discountedPrice,
    discountPercent,
    hasDiscount: discountedPrice < basePrice,
  };
}

// Display discount in UI
function ProductCard({ tokenId }: { tokenId: bigint }) {
  const { address } = useAccount();
  const [discount, setDiscount] = useState<any>(null);

  useEffect(() => {
    if (address) {
      getApplicableDiscount(tokenId, address).then(setDiscount);
    }
  }, [tokenId, address]);

  return (
    <div>
      {discount?.hasDiscount ? (
        <>
          <span className="line-through text-gray-500">
            ${Number(discount.basePrice) / 1e6}
          </span>
          <span className="text-green-600 font-bold ml-2">
            ${Number(discount.discountedPrice) / 1e6}
          </span>
          <span className="text-sm text-green-600">
            ({discount.discountPercent}% POAP holder discount!)
          </span>
        </>
      ) : (
        <span>${Number(discount?.basePrice || 0n) / 1e6}</span>
      )}
    </div>
  );
}
4. Admin Setup Example
typescript// Set up discount for ETH Global attendees
await writeContract({
  address: SWAG1155_ADDRESS,
  abi: Swag1155ABI,
  functionName: 'addDiscount',
  args: [
    1001n,              // tokenId (ETH Cali Tee - Size S)
    123456n,            // POAP event ID (e.g., ETH Global SF 2024)
    1000n,              // 10% discount (1000 basis points)
  ],
});
Key Benefits

Onchain verification - No backend needed, POAP ownership checked directly
Multiple tiers - Support different discounts for different events
Automatic application - Discount calculated when user buys
Gas efficient - Only reads POAP balance, no extra state changes
Flexible - Admin can add/remove discounts per product